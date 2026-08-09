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
import path from "path";
import { db } from "../db/index";
import * as schema from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { tradingEngine } from "../engines/TradingEngine";
import { AUDIT_LOG_FILE } from "../core/auditLog";
import { backtestEngine } from "../engines/backtest/BacktestEngine";
import { walkForwardValidator } from "../engines/backtest/WalkForwardValidator";

export const systemRouter = Router();

systemRouter.get("/audit/trail", (req: Request, res: Response) => {
  try {
    if (fs.existsSync(AUDIT_LOG_FILE)) {
      const lines = fs.readFileSync(AUDIT_LOG_FILE, "utf-8").trim().split("\n");
      return res.json(lines.map((l) => JSON.parse(l)).reverse().slice(0, 50));
    }
  } catch (e) {}
  res.json([]);
});

systemRouter.post("/system/emergency-stop", (req: Request, res: Response) => {
  console.warn("CIRCUIT BREAKER: Emergency Stop Activated by User.");
  tradingEngine.state.emergencyStopActive = true;
  tradingEngine.logHistory("veto", "EMERGENCY STOP activated. RiskAgent will reject all new trades until resumed.");
  res.json({ status: "ok", active: true });
});

systemRouter.post("/system/resume", (req: Request, res: Response) => {
  console.log("SYSTEM: Recovery initiated. Trading systems resumed.");
  tradingEngine.state.emergencyStopActive = false;
  tradingEngine.logHistory("start", "Emergency stop cleared. Trading resumed.");
  res.json({ status: "ok", active: false });
});

systemRouter.get("/system/export-db", (req: Request, res: Response) => {
  try {
    const dbPath = path.resolve(process.cwd(), "database", "argus.db");
    if (fs.existsSync(dbPath)) {
      res.download(dbPath, "argus_backup.db");
    } else {
      res.status(404).json({ error: "Database not found" });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

systemRouter.post("/system/import-db", express.raw({ type: "application/octet-stream", limit: "50mb" }), (req: Request, res: Response) => {
  try {
    const dbPath = path.resolve(process.cwd(), "database", "argus.db");
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
        dailyDate: tradingEngine.state.dayStartDateStr || new Date().toISOString().split("T")[0],
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
        // history has timestamp (unix), equity, profit_loss, profit_loss_pct
        const mapped = history.timestamp.map((t: number, i: number) => {
          const dateObj = new Date(t * 1000);
          return {
            date: dateObj.toISOString().split("T")[0],
            pnl: history.profit_loss[i] || 0,
            cumulative: history.equity[i] || 0,
          };
        });

        return res.json({ history: mapped });
      }
    } catch (e) {
      console.error("Failed to fetch Alpaca portfolio history:", e);
    }
  }

  // Stub fallback
  res.json({ history: [] });
});

// Real historical replay - runs the same deterministic technical rules TechnicalAgent.ts uses
// live against real Alpaca bars (backfilled/cached in ohlcv_bars). Replaces what used to be a
// hardcoded {returnPct:15.5, sharpe:2.1, ...} response regardless of input.
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
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
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
    const { symbols, startDate, endDate, timeframe, initialCash, trainDays, testDays } = req.body || {};
    if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
      return res.status(400).json({ error: "symbols (non-empty array) is required" });
    }
    if (!startDate || !endDate) {
      return res.status(400).json({ error: "startDate and endDate are required (ISO dates)" });
    }
    if (!trainDays || !testDays) {
      return res.status(400).json({ error: "trainDays and testDays are required (integers, e.g. trainDays:180, testDays:30)" });
    }
    const result = await walkForwardValidator.run({ symbols, startDate, endDate, timeframe, initialCash, trainDays, testDays });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

systemRouter.patch("/settings", (req: Request, res: Response) => res.json({ ok: true }));
