/**
 * System introspection / operations routes: audit trail, emergency-stop stubs,
 * DB export/import, health status, agent weights/performance, trade & memory
 * history, and P&L/backtest reporting.
 *
 * Extracted from server.ts structurally only. One Step-3 cleanup applied
 * (standardizing error handling, not a logic change): several of these routes'
 * catch blocks previously returned an unrelated hardcoded "fallback news"
 * object on any error (a copy-paste artifact); they now return
 * `{ error: message }` like every other route's error handling in this file.
 * The one byte-for-byte duplicate `/api/v1/system/export-db` registration
 * (Express only ever executed the first copy) was also removed as dead code.
 */
import express, { Router, Request, Response } from "express";
import fs from "fs";
import { db, dbPath, sqliteDb } from "../db/index";
import * as schema from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { tradingEngine } from "../engines/TradingEngine";
import { AUDIT_LOG_FILE } from "../core/auditLog";
import { getTradingDateStr } from "../core/TradingCalendar";
import { backtestEngine } from "../engines/backtest/BacktestEngine";
import { walkForwardValidator } from "../engines/backtest/WalkForwardValidator";
import { runIntegrityCheck } from "../core/IntegrityValidator";
import { tradingLimiter } from "../core/RateLimiters";
import { BrokerManager } from "../../brokers/BrokerManager";

export const systemRouter = Router();

// Real, live structural consistency check (DB tables, broker capabilities, seeded AI/news
// providers, local AI service reachability) - see IntegrityValidator.ts. Never a hardcoded score.
systemRouter.get("/system/integrity", async (req: Request, res: Response) => {
  try {
    const report = await runIntegrityCheck();
    res.json(report);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

systemRouter.get("/audit/trail", (req: Request, res: Response) => {
  try {
    if (fs.existsSync(AUDIT_LOG_FILE)) {
      const lines = fs.readFileSync(AUDIT_LOG_FILE, "utf-8").trim().split("\n");
      return res.json(lines.map((l) => JSON.parse(l)).reverse().slice(0, 50));
    }
  } catch (e) {}
  res.json([]);
});

// Real trading-safety kill switch (FINAL_ANALYSIS.md P0): a tri-state machine
// (TRADING_ENABLED | TRADING_PAUSED | EMERGENCY_STOP), persisted so it survives a restart, with
// every transition written to the immutable kill_switch_events audit table via
// TradingEngine.setTradingState(). EMERGENCY_STOP additionally cancels real outstanding broker
// orders by default (cancelOpenOrders: false in the body opts out); existing filled positions
// are never touched by any of these three endpoints.
systemRouter.post("/system/emergency-stop", tradingLimiter, async (req: Request & { actor?: string }, res: Response) => {
  try {
    const reason = (req.body?.reason && String(req.body.reason).trim()) || 'Manually triggered emergency stop.';
    const cancelOpenOrders = req.body?.cancelOpenOrders !== false;
    const actor = req.actor || 'unknown';
    console.warn(`CIRCUIT BREAKER: Emergency Stop activated by ${actor}.`);
    const result = await tradingEngine.setTradingState('EMERGENCY_STOP', { reason, actor, cancelOpenOrders });
    res.json({ status: "ok", active: true, tradingState: result.toState, cancelledOrderIds: result.cancelledOrderIds });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

systemRouter.post("/system/pause", tradingLimiter, async (req: Request & { actor?: string }, res: Response) => {
  try {
    const reason = (req.body?.reason && String(req.body.reason).trim()) || 'Manually paused.';
    const actor = req.actor || 'unknown';
    const result = await tradingEngine.setTradingState('TRADING_PAUSED', { reason, actor });
    res.json({ status: "ok", tradingState: result.toState });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

systemRouter.post("/system/resume", tradingLimiter, async (req: Request & { actor?: string }, res: Response) => {
  try {
    const reason = (req.body?.reason && String(req.body.reason).trim()) || 'Manually resumed.';
    const actor = req.actor || 'unknown';
    console.log(`SYSTEM: Recovery initiated by ${actor}.`);
    const result = await tradingEngine.setTradingState('TRADING_ENABLED', { reason, actor });
    res.json({ status: "ok", active: false, tradingState: result.toState });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

systemRouter.get("/system/trading-state", (req: Request, res: Response) => {
  res.json({
    tradingState: tradingEngine.state.tradingState,
    emergencyStopActive: tradingEngine.state.emergencyStopActive,
  });
});

// Real, durable audit trail for every kill-switch transition - distinct from the ephemeral,
// capped in-memory activity feed at GET /api/v1/autobot (history field).
systemRouter.get("/system/kill-switch-events", async (req: Request, res: Response) => {
  try {
    const rows = await db.select().from(schema.killSwitchEvents).orderBy(desc(schema.killSwitchEvents.id)).limit(100);
    res.json(rows.map(r => ({ ...r, cancelledOrderIds: r.cancelledOrderIds ? JSON.parse(r.cancelledOrderIds) : [] })));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

systemRouter.get("/system/export-db", (req: Request, res: Response) => {
  try {
    if (fs.existsSync(dbPath)) {
      // Checkpoint first - in WAL mode, recent commits can live only in the -wal file, and a
      // straight file copy of just the main .db file would silently miss them.
      sqliteDb.pragma('wal_checkpoint(TRUNCATE)');
      res.download(dbPath, "argus_backup.db");
    } else {
      res.status(404).json({ error: "Database not found" });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Writing directly under the live db file while the app holds it open in WAL mode is unsafe -
// takes a checkpoint first so the main file is fully caught up, then overwrites it. The app must
// still be restarted afterward (the running process's connection/cache is not re-opened).
systemRouter.post("/system/import-db", express.raw({ type: "application/octet-stream", limit: "50mb" }), (req: Request, res: Response) => {
  try {
    sqliteDb.pragma('wal_checkpoint(TRUNCATE)');
    fs.writeFileSync(dbPath, req.body);
    res.json({ ok: true, message: "Database imported successfully. Please restart the application." });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

systemRouter.get("/system/status", async (req: Request, res: Response) => {
  try {
    const settings = await db.select().from(schema.settings).limit(1);
    const brokers = await db.select().from(schema.brokerConnections).limit(1);
    const providers = await db.select().from(schema.aiProviders).limit(1);
    res.json({
      hasAlpaca: brokers.length > 0,
      hasGemini: providers.length > 0,
      hasSQLite: true,
      circuitBreakers: {
        dailyDate: tradingEngine.state.dayStartDateStr || getTradingDateStr(),
        loss: tradingEngine.state.currentDailyLoss,
        limit: tradingEngine.state.dailyLossLimit,
      },
      emergencyStop: tradingEngine.state.emergencyStopActive,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

systemRouter.get("/agents", async (req: Request, res: Response) => {
  try {
    const stats = await db.select().from(schema.agentPerformanceStats);
    const weights: Record<string, number> = {};
    stats.forEach((s) => {
      weights[s.agentName] = s.currentWeight;
    });
    res.json({ weights });
  } catch (e) {
    res.json({ weights: {} });
  }
});

systemRouter.get("/performance", async (req: Request, res: Response) => {
  try {
    const stats = await db.select().from(schema.agentPerformanceStats);
    const metrics: Record<string, unknown> = {};
    stats.forEach((s) => {
      metrics[s.agentName] = {
        winRate: s.winRate,
        totalTrades: s.totalPredictions,
        averageReturn: s.averageReturn,
        profitFactor: s.profitFactor,
        sharpeRatio: s.sharpeRatio,
      };
    });
    res.json(metrics);
  } catch (e) {
    res.json({});
  }
});

systemRouter.get("/trades", async (req: Request, res: Response) => {
  try {
    const allTrades = await db.select().from(schema.trades).orderBy(schema.trades.id);
    res.json(allTrades.reverse()); // Latest first
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

systemRouter.get("/agent-memory", async (req: Request, res: Response) => {
  try {
    const memories = await db.select().from(schema.agentMemory).orderBy(schema.agentMemory.id);
    res.json(memories.reverse()); // Latest first
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

systemRouter.get("/event-traces", async (req: Request, res: Response) => {
  try {
    const { correlationId } = req.query;
    const limit = Math.min(Number(req.query.limit) || 200, 1000);

    let query = db.select().from(schema.eventTraces).$dynamic();
    if (typeof correlationId === "string") {
      query = query.where(eq(schema.eventTraces.correlationId, correlationId));
    }
    const traces = await query.orderBy(desc(schema.eventTraces.timestamp)).limit(limit);
    res.json(traces);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

systemRouter.get("/pnl/analytics", async (req: Request, res: Response) => {
  if (tradingEngine.state.tradingMode !== "SIMULATOR" && process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY) {
    try {
      const isPaper = tradingEngine.state.tradingMode === "PAPER";
      const alpacaBaseUrl = isPaper ? "paper-api.alpaca.markets" : "api.alpaca.markets";
      const historyRes = await fetch(`https://${alpacaBaseUrl}/v2/account/portfolio/history?period=30d&timeframe=1D`, {
        headers: {
          "APCA-API-KEY-ID": process.env.ALPACA_API_KEY,
          "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY,
        },
      });

      if (historyRes.ok) {
        const history = await historyRes.json();
        const mapped = history.timestamp.map((t: number, i: number) => {
          const dateObj = new Date(t * 1000);
          return {
            date: dateObj.toISOString().split("T")[0],
            pnl: history.profit_loss[i] || 0,
            cumulative: history.equity[i] || 0,
          };
        });
        
        const totalProfitLoss = history.profit_loss && history.profit_loss.length > 0 ? history.profit_loss[history.profit_loss.length - 1] : 0;

        return res.json({ history: mapped, summary: { winRate: 0, totalProfitLoss } });
      }
    } catch (e) {
      console.error("Failed to fetch Alpaca portfolio history:", e);
    }
  }

  // Fallback for Paper Simulator mode
  const broker = BrokerManager.getInstance().getActiveBroker();
  try {
    const portfolio = await broker.portfolio();
    const totalProfitLoss = portfolio.equity - portfolio.cash;
    res.json({ history: [], summary: { winRate: 0, totalProfitLoss } });
  } catch (e) {
    res.json({ history: [], summary: { winRate: 0, totalProfitLoss: 0 } });
  }
});

// SAME_BAR_CLOSE BacktestEngine — quarantined from promotion. Prefer POST /api/v2/research/canonical/*.
systemRouter.post("/backtest", async (req: Request, res: Response) => {
  try {
    const { symbols, startDate, endDate, timeframe, initialCash } = req.body || {};
    if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
      return res.status(400).json({ error: "symbols (non-empty array) is required" });
    }
    if (!startDate || !endDate) {
      return res.status(400).json({ error: "startDate and endDate are required (ISO dates)" });
    }
    const result = await backtestEngine.run({ symbols, startDate, endDate, timeframe, initialCash });
    res.json({
      ...result,
      ok: true,
      quarantine: 'SAME_BAR_CLOSE_NOT_PROMOTABLE',
      promotable: false,
      live: 'NO-GO',
      promotionPath: 'POST /api/v2/research/canonical/core (NEXT_BAR_OPEN only)',
    });
  } catch (e: any) {
    const { diagnosticFromBacktestError } = await import('../diagnostics/buildDiagnostic');
    res.status(500).json({ error: e.message, diagnostic: diagnosticFromBacktestError(e.message) });
  }
});

systemRouter.get("/backtest/:id", async (req: Request, res: Response) => {
  try {
    const run = await backtestEngine.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: "Backtest run not found" });
    res.json(run);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

systemRouter.get("/backtest", async (req: Request, res: Response) => {
  try {
    res.json(await backtestEngine.listRuns());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Rolling walk-forward validation on top of the same real backtest engine - runs the identical,
// fixed strategy on successive train/test windows so in-sample vs. out-of-sample performance can
// be compared honestly. Never optimizes any parameter on the test window.
systemRouter.post("/backtest/walk-forward", async (req: Request, res: Response) => {
  try {
    const { symbols, strategyId, symbol, startDate, endDate, timeframe, initialCash, trainDays, testDays } = req.body || {};
    // E5 - either the original run()-backed mode (symbols) or the quant-layer mode
    // (strategyId+symbol) - exactly one, matching WalkForwardValidator.run()'s own validation.
    const quantMode = !!(strategyId && symbol);
    if (!quantMode && (!symbols || !Array.isArray(symbols) || symbols.length === 0)) {
      return res.status(400).json({ error: "Either symbols (non-empty array) or both strategyId and symbol is required" });
    }
    if (!startDate || !endDate) {
      return res.status(400).json({ error: "startDate and endDate are required (ISO dates)" });
    }
    if (!trainDays || !testDays) {
      return res.status(400).json({ error: "trainDays and testDays are required (integers, e.g. trainDays:180, testDays:30)" });
    }
    const result = await walkForwardValidator.run({ symbols, strategyId, symbol, startDate, endDate, timeframe, initialCash, trainDays, testDays });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

systemRouter.patch("/settings", (req: Request, res: Response) => res.json({ ok: true }));
