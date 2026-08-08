/**
 * ==========================================================
 * Module:
 * v2System.ts
 *
 * Purpose:
 * Core implementation and logic for the v2System.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for v2System
 * - Interface with backend APIs and EventBus
 * - Render UI components (if React)
 *
 * Inputs:
 * - Module dependencies and injected props
 *
 * Outputs:
 * - Formatted data or React Elements
 *
 * Emits:
 * - Relevant system events
 *
 * Dependencies:
 * - Standard Argus architecture layers
 *
 * Called By:
 * - Argus Routing / Parent Components
 *
 * Never:
 * - Mutate global state directly without EventBus
 * - Call AI providers directly (Must use AIRouter)
 *
 * ==========================================================
 */

import "../core/EventStore";
import { Router } from 'express';
import { system } from '../core/SystemBootstrap';
import { db } from '../db';
import { trades, portfolio, learnedRules, agentPerformanceStats } from '../db/schema';
import { desc, eq } from 'drizzle-orm';

export const v2Router = Router();

v2Router.get('/agents/performance', async (req, res) => {
  try {
    const stats = await db.select().from(agentPerformanceStats).all();
    res.json({ ok: true, stats });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

v2Router.post('/system/toggle', (req, res) => {
  const { enabled, mode } = req.body;
  
  if (enabled) {
    system.start(mode || 'SIMULATION');
  } else {
    system.stop();
  }
  
  res.json({ ok: true, status: system.getStatus() });
});

v2Router.get('/system/status', (req, res) => {
  res.json({ 
    ok: true, 
    status: system.getStatus(),
    workers: [
      { id: "market-data-worker", name: "Market Data Worker", status: system.getStatus().running ? "ACTIVE" : "STOPPED", description: "Consuming WebSocket streams from Alpaca/Polygon" },
      { id: "news-agent", name: "News Intelligence Agent", status: system.getStatus().running ? "ACTIVE" : "STOPPED", description: "Scraping headlines, computing sentiment scores" },
      { id: "technical-engine", name: "Technical Quant Engine", status: system.getStatus().running ? "ACTIVE" : "STOPPED", description: "Computing RSI, MACD, SMA across feature store" },
      { id: "portfolio-monitor", name: "Portfolio Manager", status: system.getStatus().running ? "ACTIVE" : "STOPPED", description: "Scanning current positions for exit criteria" },
      { id: "chief-trader", name: "Chief Trader Node", status: system.getStatus().running ? "ACTIVE" : "STOPPED", description: "Gathering consensus, routing to Risk layer" },
      { id: "risk-manager", name: "Risk Management Node", status: system.getStatus().running ? "ACTIVE" : "STOPPED", description: "Validating budget, ATR stop-distance caps" },
      { id: "order-management", name: "Order Management System", status: system.getStatus().running ? "ACTIVE" : "STOPPED", description: "Executing trades against live/paper Broker API" }
    ]
  });
});

v2Router.get('/data/trades', async (req, res) => {
  try {
    const allTrades = await db.select().from(trades).orderBy(desc(trades.timestamp)).limit(50).all();
    res.json({ ok: true, trades: allTrades });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

v2Router.get('/data/portfolio', async (req, res) => {
  try {
    const holdings = await db.select().from(portfolio).all();
    res.json({ ok: true, portfolio: holdings });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

v2Router.post('/system/backtest', async (req, res) => {
  const { strategy, symbol, timeframe } = req.body;
  // Placeholder backtest logic
  setTimeout(() => {
    res.json({
      ok: true,
      results: {
        strategy,
        symbol,
        trades: 450,
        winRate: 64.2,
        profitFactor: 1.85,
        maxDrawdown: 8.4,
        averageReturn: 12.5,
        sharpeRatio: 1.6
      }
    });
  }, 2000);
});

import { recentEvents } from '../core/EventStore';

v2Router.get('/system/events', (req, res) => {
  res.json({ ok: true, events: recentEvents });
});

import { explainabilityReports } from '../db/schema';
import { tradeTraces } from '../core/EventStore';

v2Router.get('/system/trace/:traceId', (req, res) => {
  const { traceId } = req.params;
  const trace = tradeTraces[traceId] || [];
  res.json({ ok: true, trace });
});

v2Router.get('/data/explainability/:traceId', async (req, res) => {
  try {
    const { traceId } = req.params;
    const report = await db.select().from(explainabilityReports).where(eq(explainabilityReports.traceId, traceId)).get();
    res.json({ ok: true, report });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
