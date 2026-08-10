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
import { backtestEngine } from '../engines/backtest/BacktestEngine';

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

// Thin delegate to the same real BacktestEngine that POST /api/v1/backtest uses - this used to be
// a second, independently-fabricated result set (trades:450, winRate:64.2%...) returned via a
// setTimeout regardless of strategy/symbol/timeframe. No frontend caller was found for this route
// (confirmed via repo-wide grep) - kept as a real endpoint rather than removed, but no longer
// duplicating fake logic.
v2Router.post('/system/backtest', async (req, res) => {
  try {
    const { symbol, symbols, startDate, endDate, timeframe, initialCash } = req.body || {};
    const symbolList = symbols || (symbol ? [symbol] : null);
    if (!symbolList || symbolList.length === 0) {
      return res.status(400).json({ ok: false, error: "symbol or symbols is required" });
    }
    if (!startDate || !endDate) {
      return res.status(400).json({ ok: false, error: "startDate and endDate are required (ISO dates)" });
    }
    const result = await backtestEngine.run({ symbols: symbolList, startDate, endDate, timeframe, initialCash });
    res.json({ ok: true, results: result });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

import { recentEvents } from '../core/EventStore';

v2Router.get('/system/events', (req, res) => {
  res.json({ ok: true, events: recentEvents });
});

import { explainabilityReports, eventTraces } from '../db/schema';
import { tradeTraces } from '../core/EventStore';

// In-memory tradeTraces is capped and lost on restart. Fall back to the durable
// event_traces table (written by EventStore.ts) so a trace started before the
// last restart, or evicted from memory, can still be replayed.
v2Router.get('/system/trace/:traceId', async (req, res) => {
  const { traceId } = req.params;
  const inMemory = tradeTraces[traceId];
  if (inMemory && inMemory.length > 0) {
    return res.json({ ok: true, trace: inMemory, source: 'memory' });
  }
  try {
    const rows = await db.select().from(eventTraces).where(eq(eventTraces.correlationId, traceId)).orderBy(eventTraces.timestamp).all();
    const trace = rows.map(r => ({
      eventId: r.id,
      correlationId: r.correlationId,
      source: r.source,
      type: r.eventType,
      timestamp: r.timestamp,
      payload: r.payload ? JSON.parse(r.payload) : null,
    }));
    res.json({ ok: true, trace, source: 'db' });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
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

// ==========================================================================================
// Transaction Observatory (TRANSACTION_OBSERVATORY_ARCHITECTURE.md, Phase 5)
//
// /transactions - list/search over the canonical transaction ledger (Phase 0's fix for the bug
// where a trade's traceId only ever identified one contributing agent's own emission).
// /transactions/:id - the single "assemble everything about this transaction" endpoint the
// replay UI is built on. Every field is a column read from a real table - no recomputation, no
// model calls, matching the "replay must be deterministic" requirement. Missing stages (a
// transaction that never reached risk, or a risk-rejected one that never reached an order) are
// simply absent (null) - never fabricated.
// ==========================================================================================
import { transactions, consensusDecisions, consensusEvidence, riskAssessments, riskGateResults, fills } from '../db/schema';
import { desc as descOrder, like as likeOp, and as andOp } from 'drizzle-orm';

v2Router.get('/transactions', async (req, res) => {
  try {
    const { symbol, status, limit } = req.query as { symbol?: string; status?: string; limit?: string };
    const conditions = [];
    if (symbol) conditions.push(likeOp(transactions.symbol, `%${symbol}%`));
    if (status) conditions.push(eq(transactions.status, status));
    const capped = Math.min(parseInt(limit || '50', 10) || 50, 200);

    const rows = conditions.length > 0
      ? await db.select().from(transactions).where(andOp(...conditions)).orderBy(descOrder(transactions.openedAt)).limit(capped)
      : await db.select().from(transactions).orderBy(descOrder(transactions.openedAt)).limit(capped);
    res.json({ ok: true, transactions: rows });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

async function assembleTransaction(id: string) {
  const transaction = await db.select().from(transactions).where(eq(transactions.id, id)).get();
  if (!transaction) return null;

  const consensusDecision = await db.select().from(consensusDecisions).where(eq(consensusDecisions.transactionId, id)).get() ?? null;
  const evidence = await db.select().from(consensusEvidence).where(eq(consensusEvidence.transactionId, id));
  const riskAssessment = await db.select().from(riskAssessments).where(eq(riskAssessments.transactionId, id)).get() ?? null;
  const riskGates = riskAssessment
    ? await db.select().from(riskGateResults).where(eq(riskGateResults.traceId, riskAssessment.traceId)).orderBy(riskGateResults.sequence)
    : [];
  const order = await db.select().from(trades).where(eq(trades.transactionId, id)).get() ?? null;
  const orderFills = order ? await db.select().from(fills).where(eq(fills.orderId, order.id)) : [];
  const events = await db.select().from(eventTraces).where(eq(eventTraces.transactionId, id)).orderBy(eventTraces.timestamp);

  return {
    transaction,
    consensusDecision,
    evidence,
    riskAssessment,
    riskGates: riskGates.map(g => ({ ...g, detail: g.detail ? JSON.parse(g.detail) : null })),
    order,
    fills: orderFills,
    events: events.map(e => ({ ...e, payload: e.payload ? JSON.parse(e.payload) : null })),
  };
}

v2Router.get('/transactions/:id', async (req, res) => {
  try {
    const data = await assembleTransaction(req.params.id);
    if (!data) return res.status(404).json({ ok: false, error: `No transaction found for id ${req.params.id}` });
    res.json({ ok: true, ...data });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==========================================================================================
// Phase 8 - human-readable report + exports, generated on demand from the current relational
// data (never a separately-maintained appended file, so it can never go stale from a crashed
// writer - see TRANSACTION_OBSERVATORY_ARCHITECTURE.md's logging-architecture section).
// ==========================================================================================
function renderTransactionMarkdown(data: NonNullable<Awaited<ReturnType<typeof assembleTransaction>>>): string {
  const { transaction, consensusDecision, evidence, riskAssessment, riskGates, order, fills } = data;
  const lines: string[] = [];
  lines.push(`# ${transaction.symbol} ${transaction.finalDecision || transaction.status} — Transaction Investigation`);
  lines.push('');
  lines.push(`**Transaction ID:** ${transaction.id}`);
  lines.push(`**Opened:** ${transaction.openedAt}${transaction.closedAt ? `  **Closed:** ${transaction.closedAt}` : ''}`);
  lines.push('');
  lines.push('## Final Result');
  lines.push('');
  lines.push(`**${transaction.finalDecision || transaction.status}** ${transaction.finalDecision ? (riskAssessment?.approved ? '✓' : riskAssessment ? '✕' : '') : ''}`);
  lines.push('');

  lines.push('## Why?');
  lines.push('');
  if (evidence.length === 0) {
    lines.push('_No agent evidence recorded._');
  } else {
    for (const e of evidence) {
      lines.push(`- **${e.agent}**: ${e.side} ${(e.confidence * 100).toFixed(0)}% (weight ${e.weight.toFixed(2)}) ${e.agreed ? '' : '_(disagreed with final consensus)_'}`);
    }
  }
  lines.push('');

  if (consensusDecision) {
    lines.push('## Chief Trader');
    lines.push('');
    lines.push(`Consensus: ${(consensusDecision.weightedConfidence * 100).toFixed(1)}% (threshold ${(consensusDecision.threshold * 100).toFixed(0)}%)`);
    lines.push('');
    if (consensusDecision.reasoning) lines.push(`> ${consensusDecision.reasoning}`);
    lines.push('');
  }

  lines.push('## Risk');
  lines.push('');
  if (!riskAssessment) {
    lines.push('_Not evaluated - this transaction never reached RiskEngine._');
  } else {
    const passedCount = riskGates.filter(g => g.passed).length;
    lines.push(`${passedCount}/${riskGates.length} gates passed.`);
    lines.push('');
    for (const g of riskGates) {
      const mark = g.detail?.skipped ? '—' : g.passed ? '✓' : '✕';
      lines.push(`- ${mark} ${g.gateName}`);
    }
    lines.push('');
    lines.push(riskAssessment.approved ? `**Approved** - max ${riskAssessment.maxQuantity} shares.` : `**Rejected** at \`${riskAssessment.rejectionGate}\`: ${riskAssessment.reasoning}`);
  }
  lines.push('');

  lines.push('## Execution');
  lines.push('');
  if (!order) {
    lines.push('_No order was placed._');
  } else {
    lines.push(`Order ${order.status}. Submitted ${order.submittedAt || '--'}, accepted ${order.acceptedAt || '--'}, filled ${order.filledAt || '--'}.`);
    if (fills.length > 0) {
      lines.push('');
      for (const f of fills) lines.push(`- ${f.quantity} @ $${f.price.toFixed(2)} (${f.filledAt})`);
    }
  }
  lines.push('');

  lines.push('## Outcome');
  lines.push('');
  lines.push(transaction.outcome === 'PENDING' ? '_Outcome pending._' : transaction.outcome);
  lines.push('');

  return lines.join('\n');
}

v2Router.get('/transactions/:id/report.md', async (req, res) => {
  try {
    const data = await assembleTransaction(req.params.id);
    if (!data) return res.status(404).send(`No transaction found for id ${req.params.id}`);
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.send(renderTransactionMarkdown(data));
  } catch (e: any) {
    res.status(500).send(e.message);
  }
});

v2Router.get('/transactions/:id/export', async (req, res) => {
  try {
    const data = await assembleTransaction(req.params.id);
    if (!data) return res.status(404).json({ ok: false, error: `No transaction found for id ${req.params.id}` });
    const format = (req.query.format as string) || 'json';

    if (format === 'md') {
      res.set('Content-Type', 'text/markdown; charset=utf-8');
      return res.send(renderTransactionMarkdown(data));
    }
    if (format === 'csv') {
      const header = 'agent,side,confidence,weight,agreed,sourceTraceId';
      const rows = data.evidence.map(e => [e.agent, e.side, e.confidence, e.weight, e.agreed, e.sourceTraceId || ''].join(','));
      res.set('Content-Type', 'text/csv; charset=utf-8');
      return res.send([header, ...rows].join('\n'));
    }
    if (format === 'jsonl') {
      res.set('Content-Type', 'application/x-ndjson; charset=utf-8');
      return res.send(data.events.map(e => JSON.stringify(e)).join('\n'));
    }
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify({ ok: true, ...data }, null, 2));
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
