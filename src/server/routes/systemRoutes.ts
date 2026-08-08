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
import { tradingEngine } from "../engines/TradingEngine";
import { AUDIT_LOG_FILE } from "../core/auditLog";

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
  res.json({ status: "ok", active: true });
});

systemRouter.post("/system/resume", (req: Request, res: Response) => {
  console.log("SYSTEM: Recovery initiated. Trading systems resumed.");
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
      circuitBreakers: { dailyDate: new Date().toISOString().split("T")[0], loss: 0 },
      emergencyStop: false,
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
    const traces = await db.select().from(schema.eventTraces).orderBy(schema.eventTraces.id);
    res.json(traces.reverse()); // Latest first
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

systemRouter.post("/backtest", (req: Request, res: Response) => {
  // Basic mock backtest
  res.json({
    returnPct: 15.5,
    sharpe: 2.1,
    maxDrawdown: 0.05,
    trades: 12,
    curve: [],
  });
});

systemRouter.patch("/settings", (req: Request, res: Response) => res.json({ ok: true }));
