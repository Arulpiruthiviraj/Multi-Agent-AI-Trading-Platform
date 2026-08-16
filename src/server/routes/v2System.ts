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
import { trades, portfolio, learnedRules, agentPerformanceStats, newsArticles, settings, quantAssessments, quantStrategyBacktests, quantBacktestDecisionLog } from '../db/schema';
import { computeFailureBreakdown } from '../quant/analysis/FailureClassification';
import { runMonteCarlo } from '../quant/analysis/MonteCarlo';
import { desc, eq } from 'drizzle-orm';
import { backtestEngine } from '../engines/backtest/BacktestEngine';
import { tradingLimiter, backtestLimiter } from '../core/RateLimiters';
import { rsiEngine } from '../engines/RSIEngine';
import { historicalDataGateway } from '../engines/backtest/HistoricalDataGateway';
import { computeAgentSynergyMatrix, REAL_AGENT_NAMES } from '../services/AgentSynergy';
import { getSector } from '../engines/PositionSizing';
import { v4 as uuidv4 } from 'uuid';
import { eventBus } from '../core/EventBus';
import { recordConsensusTransaction } from '../core/TransactionRegistry';
import { oms } from '../services/OrderManagement';
import { ALL_STRATEGIES, EXPERIMENTAL_STRATEGIES, isExperimentalStrategyLive } from '../quant/strategies/StrategyEngine';
import { STRATEGY_TYPICAL_HOLDING_PERIOD } from '../quant/strategies/types';
import { experimentalStrategyRow } from '../config/quantExperimentalStrategies';
import { quantStrategyTaxonomySummary } from '../config/quantStrategyTaxonomy';
import { deskIntelligence } from '../config/deskIntelligence';
import { listRecentNewsCatalysts } from '../services/NewsCatalystStore';
import { noTradeReasonsConfig } from '../config/noTradeReasons';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';

export const v2Router = Router();

v2Router.get('/agents/performance', async (req, res) => {
  try {
    const stats = await db.select().from(agentPerformanceStats).all();
    res.json({ ok: true, stats });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

v2Router.post('/system/toggle', tradingLimiter, (req, res) => {
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
v2Router.post('/system/backtest', backtestLimiter, async (req, res) => {
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
import { explainabilityReports, eventTraces } from '../db/schema';
import { tradeTraces } from '../core/EventStore';
import { gt as gtOp, asc as ascOp } from 'drizzle-orm';

// Hardening pass, Phase 9 (WebSocket reconnect backfill): the live /ws stream has no memory of
// what a client missed while disconnected - a real gap (network blip, reconnect, tab backgrounded
// by the OS) previously just lost every event in that window from the frontend's perspective. The
// `since` param is additive and opt-in: with no param, behavior is byte-for-byte unchanged
// (returns the in-memory recentEvents ring buffer, exactly as before). With `since` (a client's
// own last-known timestamp, captured client-side at disconnect time - see WebSocketContext.tsx),
// this instead queries the durable `event_traces` table (written by EventStore.ts for every
// decision-lifecycle event type - MARKET_DATA/CALCULATION_COMPLETED are deliberately excluded
// there and remain excluded here) for real events the client missed, capped at the same 200-event
// limit the in-memory buffer already uses.
v2Router.get('/system/events', async (req, res) => {
  const since = req.query.since ? parseInt(req.query.since as string, 10) : null;
  if (since === null || !Number.isFinite(since)) {
    return res.json({ ok: true, events: recentEvents });
  }
  try {
    const rows = await db.select().from(eventTraces).where(gtOp(eventTraces.timestamp, since)).orderBy(ascOp(eventTraces.timestamp)).limit(200);
    const events = rows.map(r => ({
      eventId: r.id,
      correlationId: r.correlationId,
      source: r.source,
      type: r.eventType,
      timestamp: r.timestamp,
      payload: r.payload ? JSON.parse(r.payload) : null,
    }));
    res.json({ ok: true, events, backfill: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

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

// Phase 8 (ARGUS_PRE_IMPLEMENTATION_BASELINE.md) - real, per-call AI ledger and real quant
// feature-snapshot data both already existed (`ai_calls`, `quant_assessments`) but neither was
// ever joined into the one "assemble everything about this decision" function - a real, previously
// unlinked gap, not new infrastructure.
import { lte as lteOp, inArray as inArrayOp, or as orOp, and as andForQuant } from 'drizzle-orm';

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

  // Real AI call ledger for this decision - every real prompt/raw response/parsed response any
  // contributing agent produced, joined by transactionId directly OR by traceId for calls made
  // before ChiefTraderAgent minted this transaction id (News/Fundamental/Macro analyze BEFORE
  // consensus is evaluated - see aiCalls' own schema comment).
  const sourceTraceIds = Array.from(new Set(evidence.map(e => e.sourceTraceId).filter((t): t is string => !!t)));
  const aiCallRows = await db.select().from(aiCallsTable).where(
    sourceTraceIds.length > 0
      ? orOp(eq(aiCallsTable.transactionId, id), inArrayOp(aiCallsTable.traceId, sourceTraceIds))
      : eq(aiCallsTable.transactionId, id)
  ).orderBy(aiCallsTable.createdAt);

  // Real quant feature snapshot closest in time to (but not after) this transaction's own
  // openedAt - quant_assessments is written on QuantSignalAgent's own 5-minute cycle, not
  // per-transaction, so this is the real, honest "what did the quant layer see right before this
  // decision" answer, not a fabricated exact match.
  const quantAssessment = await db.select().from(quantAssessments)
    .where(andForQuant(eq(quantAssessments.symbol, transaction.symbol), lteOp(quantAssessments.createdAt, transaction.openedAt)))
    .orderBy(desc(quantAssessments.createdAt)).limit(1).get() ?? null;

  return {
    transaction,
    consensusDecision,
    evidence,
    riskAssessment,
    riskGates: riskGates.map(g => ({ ...g, detail: g.detail ? JSON.parse(g.detail) : null })),
    order,
    fills: orderFills,
    events: events.map(e => ({ ...e, payload: e.payload ? JSON.parse(e.payload) : null })),
    aiCalls: aiCallRows,
    quantAssessment: quantAssessment ? {
      ...quantAssessment,
      regime: quantAssessment.regime ? JSON.parse(quantAssessment.regime) : null,
      marketContext: quantAssessment.marketContext ? JSON.parse(quantAssessment.marketContext) : null,
      strategyEvaluations: quantAssessment.strategyEvaluations ? JSON.parse(quantAssessment.strategyEvaluations) : null,
      groupedScores: quantAssessment.groupedScores ? JSON.parse(quantAssessment.groupedScores) : null,
      aiContradictionAnalysis: quantAssessment.aiContradictionAnalysis ? JSON.parse(quantAssessment.aiContradictionAnalysis) : null,
    } : null,
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
  const { transaction, consensusDecision, evidence, riskAssessment, riskGates, order, fills, aiCalls: aiCallRows, quantAssessment } = data;
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

  // Phase 8 (ARGUS_PRE_IMPLEMENTATION_BASELINE.md) - real AI call ledger + quant feature snapshot,
  // now actually joined into this report instead of sitting in unlinked tables.
  lines.push('## AI Calls');
  lines.push('');
  if (aiCallRows.length === 0) {
    lines.push('_No AI provider calls recorded for this decision._');
  } else {
    for (const c of aiCallRows) {
      lines.push(`- **${c.agent}** via ${c.provider}${c.model ? `/${c.model}` : ''} - ${c.status}${c.latencyMs ? ` (${Math.round(c.latencyMs)}ms)` : ''}${c.cost ? `, $${c.cost.toFixed(4)}` : ''}`);
    }
  }
  lines.push('');

  lines.push('## Quant Feature Snapshot');
  lines.push('');
  if (!quantAssessment) {
    lines.push('_No quant_assessments row found at or before this decision\'s open time (QuantEngine may be disabled, or this symbol was not on its 5-minute cycle)._');
  } else {
    lines.push(`Regime/context captured at ${quantAssessment.createdAt}.`);
  }
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

// ==========================================================================================
// Real Mission Control metrics (req #14) - every number below is a real query/state read, no
// Date.now()/Math.random() placeholders. An agent/model/broker that hasn't produced a real
// signal recently is honestly reported as inactive/unhealthy, never assumed healthy by default.
// ==========================================================================================
import { agentPredictions, aiProviders, aiCalls as aiCallsTable } from '../db/schema';
import { gte as gteOp } from 'drizzle-orm';
import { marketDataWorker } from '../services/MarketDataWorker';
import { tradingSafety } from '../config/tradingSafety';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { agentWeightConfig } from '../config/agentWeights';
import { MARKET_REGISTRY } from '../markets/MarketRegistry';
import { quantThresholds } from '../config/quantThresholds';
import { BrokerManager } from '../../brokers/BrokerManager';
import { tradingEngine } from '../engines/TradingEngine';

const PIPELINE_AGENTS = agentWeightConfig.pipelineAgents;
const AGENT_ACTIVITY_WINDOW_MS = runtimeIntervals.agentActivityWindowMs;

v2Router.get('/system/mission-control', async (req, res) => {
  try {
    const now = Date.now();
    const todayStr = new Date().toISOString().slice(0, 10);

    // Agents active: real recency of each agent's own logged predictions (agent_predictions),
    // not a fabricated "5/5" - an agent that hasn't produced anything in the activity window
    // (e.g. no ALPHAVANTAGE_API_KEY configured) is honestly counted as inactive.
    const predictions = await db.select().from(agentPredictions);
    const lastSeenByAgent = new Map<string, number>();
    for (const p of predictions) {
      const t = new Date(p.timestamp).getTime();
      if (!lastSeenByAgent.has(p.agentName) || t > lastSeenByAgent.get(p.agentName)!) lastSeenByAgent.set(p.agentName, t);
    }
    const agentsActive = PIPELINE_AGENTS.filter(a => {
      const last = lastSeenByAgent.get(a);
      return last !== undefined && now - last < AGENT_ACTIVITY_WINDOW_MS;
    }).length;

    // AI models healthy: real ai_providers.health, not a static claim.
    const providers = await db.select().from(aiProviders).where(eq(aiProviders.enabled, true));
    const aiModelsHealthy = providers.filter(p => p.health === 'Healthy').length;

    // Broker: real active broker + its real capability flags.
    let brokerName = 'None';
    let brokerCapabilities: any = null;
    try {
      const broker = BrokerManager.getInstance().getActiveBroker();
      brokerName = broker.name;
      brokerCapabilities = broker.getCapabilities();
    } catch { /* no active broker configured */ }

    // Trades today / win rate / realized P&L: real trades rows for today only.
    const allTrades = await db.select().from(trades);
    const todaysFilled = allTrades.filter(t => t.status === 'FILLED' && t.timestamp?.startsWith(todayStr));
    const withPnl = todaysFilled.filter(t => t.profitLoss !== null && t.profitLoss !== undefined);
    const wins = withPnl.filter(t => (t.profitLoss ?? 0) > 0).length;
    const winRate = withPnl.length > 0 ? wins / withPnl.length : null;
    const realizedPnlToday = withPnl.length > 0 ? withPnl.reduce((s, t) => s + (t.profitLoss ?? 0), 0) : null;

    // AI cost today: real ai_calls.cost, not ai_usage's aggregate (this is the forensic ledger).
    const callsToday = await db.select().from(aiCallsTable).where(gteOp(aiCallsTable.createdAt, todayStr));
    const aiCostToday = callsToday.reduce((s, c) => s + (c.cost || 0), 0);

    // Events/sec: real count over the in-memory ring buffer's last 10s window.
    const recentWindowMs = 10_000;
    const eventsInWindow = recentEvents.filter(e => now - e.timestamp < recentWindowMs).length;
    const eventsPerSec = Number((eventsInWindow / (recentWindowMs / 1000)).toFixed(2));

    res.json({
      ok: true,
      marketData: { connected: marketDataWorker.isConnected() },
      agents: { active: agentsActive, total: PIPELINE_AGENTS.length },
      aiModels: { healthy: aiModelsHealthy, total: providers.length },
      broker: { name: brokerName, capabilities: brokerCapabilities },
      riskEngine: { armed: !tradingEngine.state.emergencyStopActive },
      autobot: { running: tradingEngine.state.enabled === true },
      tradesToday: todaysFilled.length,
      winRate,
      realizedPnlToday,
      aiCostToday: Number(aiCostToday.toFixed(4)),
      eventsPerSec,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==========================================================================================
// Phase 3B (FINAL_ANALYSIS.md's 4-phase remediation plan) - real strategy-widget data.
//
// /strategy/rsi-scan replaces StrategyScanner.tsx's getMockPrices() (a charCodeAt()-seeded fake
// 40-bar series per symbol, fed into a real Wilder's RSI calculation - a mathematically correct
// signal computed on fictional input) with real cached OHLCV bars and the same rsiEngine already
// used by BacktestEngine. A symbol with too little real history reports dataAvailable:false with
// the real reason, never a fabricated RSI number.
//
// /strategy/agent-synergy replaces StrategySynergyMatrix.tsx's fabricated correlation matrix -
// which correlated invented agent names ("Macro", "Sentiment", "Event", "Geopol", none of which
// are real agents in this codebase) via a deterministic index-seeded formula - with a real Pearson
// correlation over real agent_predictions rows for the actual five agents this codebase runs.
// ==========================================================================================
const RSI_SCAN_DEFAULT_SYMBOLS = MARKET_REGISTRY.rsiScanDefaultSymbols;
const RSI_SCAN_UNAVAILABLE_SYMBOLS = new Set(MARKET_REGISTRY.rsiScanUnavailableSymbols);
const RSI_MIN_BARS = quantThresholds.rsiMinBars;
const RSI_SCAN_LOOKBACK_MS = tradingSafety.correlationLookbackMs;

function rsiSignal(rsi: number): 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL' {
  if (rsi >= quantThresholds.rsiOverbought) return 'OVERBOUGHT';
  if (rsi <= quantThresholds.rsiOversold) return 'OVERSOLD';
  return 'NEUTRAL';
}

v2Router.get('/strategy/rsi-scan', async (req, res) => {
  try {
    const requested = (req.query.symbols as string | undefined)?.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const symbols = requested && requested.length > 0 ? requested : RSI_SCAN_DEFAULT_SYMBOLS;
    const endMs = Date.now();
    const startMs = endMs - RSI_SCAN_LOOKBACK_MS;

    const results = await Promise.all(symbols.map(async (symbol) => {
      if (RSI_SCAN_UNAVAILABLE_SYMBOLS.has(symbol)) {
        return { symbol, dataAvailable: false, reason: `${symbol} is not available - Alpaca's equities-bars endpoint does not serve crypto and no real crypto market-data source is wired into Argus.` };
      }
      let ensureError: string | undefined;
      try {
        await historicalDataGateway.ensureBars(symbol, '1Day', startMs, endMs);
      } catch (e: any) {
        ensureError = e.message; // fall through - already-cached bars may still be enough even if this refresh failed
      }
      const bars = await historicalDataGateway.getBars(symbol, '1Day', startMs, endMs);
      if (bars.length < RSI_MIN_BARS) {
        return { symbol, dataAvailable: false, reason: ensureError || `Only ${bars.length} real daily bars cached - need at least ${RSI_MIN_BARS} for a trustworthy RSI reading.` };
      }
      const closes = bars.map(b => b.close);
      const rsi = rsiEngine.calculate(closes);
      return { symbol, dataAvailable: true, price: closes[closes.length - 1], rsi: Number(rsi.toFixed(2)), signal: rsiSignal(rsi), barsUsed: bars.length };
    }));

    res.json({ ok: true, results });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

v2Router.get('/strategy/agent-synergy', async (req, res) => {
  try {
    const windowDays = 30;
    const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = await db.select().from(agentPredictions).where(gteOp(agentPredictions.timestamp, sinceIso));
    const result = computeAgentSynergyMatrix(rows.map(r => ({
      agentName: r.agentName, symbol: r.symbol, prediction: r.prediction, confidence: r.confidence, timestamp: r.timestamp,
    })));
    res.json({ ok: true, ...result, windowDays, sampleSize: rows.length });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==========================================================================================
// Phase 3C (FINAL_ANALYSIS.md's 4-phase remediation plan) - real manual-override execution.
//
// The Advanced Trade Sandbox's "Execute Override" button used to build a fabricated Trade object
// entirely client-side and push it into local React state - it never reached the backend, so
// nothing about it was real. This endpoint deliberately does NOT call OrderManagementService (or
// BrokerManager) directly - that would recreate the exact "raw path around the safety gate" bug
// class already found and fixed multiple times in this codebase (Sections 16, 22.3). Instead it
// emits a real CHIEF_APPROVED_IDEA event - the same event RiskAgent already listens for after
// ChiefTraderAgent's own AI-consensus approval - carrying a real live price from
// marketDataWorker. That means a manual override still passes through every real RiskEngine gate
// (emergency stop, circuit breakers, ATR-based sizing, sector/correlation caps) and the real
// OrderManagementService/broker call; only ChiefTraderAgent's AI-consensus step is skipped, which
// is the entire point of an operator override. recordConsensusTransaction() mints a real
// transactions/consensus_decisions row so this stays visible in the Transaction Observatory,
// honestly tagged with agent 'ManualOverride' and debateUsed:false rather than pretending an AI
// agent produced it. The actual approved quantity is whatever RiskEngine's real sizing computes -
// never a client-supplied number - reported back asynchronously via the existing
// RISK_ASSESSMENT_COMPLETED / ORDER_EXECUTED WebSocket broadcasts every other real trade uses.
// ==========================================================================================
v2Router.post('/trading/execute-override', tradingLimiter, async (req, res) => {
  try {
    const { symbol, side } = req.body || {};
    if (typeof symbol !== 'string' || !symbol || (side !== 'BUY' && side !== 'SELL')) {
      return res.status(400).json({ ok: false, error: 'symbol (string) and side ("BUY" | "SELL") are required' });
    }

    const currentPrice = marketDataWorker.getLatestPrice(symbol);
    if (currentPrice === null) {
      return res.status(422).json({ ok: false, error: `No real live price available for ${symbol} yet - cannot size or risk-evaluate an override without one. Wait for a market data tick or confirm the symbol is correct.` });
    }

    const traceId = `manual-override-${uuidv4()}`;
    const reasoning = 'Manual consensus override submitted via the Advanced Trade Sandbox - a human operator deliberately bypassed AI swarm consensus.';
    const transactionId = await recordConsensusTransaction({
      symbol, side, weightedConfidence: 1.0, threshold: 0, approved: true,
      reasoning, debateUsed: false,
      evidence: [{ agent: 'ManualOverride', side, confidence: 1.0, weight: 1.0, reasoning: 'Human-submitted override - not an AI agent signal.', currentPrice }],
    });

    eventBus.emit('CHIEF_APPROVED_IDEA', {
      traceId, transactionId, symbol, side, confidence: 1.0, reasoning,
      agentsContext: 'ManualOverride', currentPrice,
    });

    res.json({ ok: true, traceId, transactionId, currentPrice });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==========================================================================================
// Hardening pass, Phase 2 (order lifecycle) - real cancellation of a still-open order via the
// broker adapter's own cancelOrder(). Calls straight into OrderManagementService.cancelOrder(),
// which refuses cleanly (200 with ok:false, never a fabricated success) for anything that isn't a
// genuine broker-confirmed cancellation: order not found, already terminal, no broker order id
// yet, or a broker whose adapter doesn't claim canCancelOrders.
// ==========================================================================================
v2Router.post('/trading/cancel-order/:id', tradingLimiter, async (req, res) => {
  try {
    const result = await oms.cancelOrder(req.params.id);
    if (!result.ok) {
      return res.status(409).json({ ok: false, error: result.reason });
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==========================================================================================
// Phase 1A (Remediation Verification Pass, FINAL_ANALYSIS.md Section 25's UI-truth-wiring
// follow-up) - real 7-day sentiment trend, replacing MarketSentimentTrend.tsx's hardcoded
// `MockSentimentData` array. Both series are real:
//   - `sentiment`: daily average of news_articles.sentimentScore (NewsScoringEngine's real
//     per-article score, 0-100), grouped by the article's real publishedAt date. Days with zero
//     scored articles are simply absent from the response rather than interpolated/fabricated.
//   - `index`: real SPY daily closes via the same HistoricalDataGateway/Alpaca-backed bar cache
//     BacktestEngine and RiskEngine's correlation gate already use - not a second, invented data
//     source. Falls back to omitting the field per-day (never a fabricated price) if no real bar
//     exists for that date.
// `available:false` (not an empty 200) is returned when there is no real scored news in the
// window at all, so the frontend can render an honest DATA_UNAVAILABLE state instead of an empty
// chart that looks like "zero sentiment" rather than "no data".
// ==========================================================================================
v2Router.get('/market/sentiment-trend', async (req, res) => {
  try {
    const days = 7;
    const now = Date.now();
    const startMs = now - days * 24 * 60 * 60 * 1000;

    const rows = await db.select().from(newsArticles).where(gteOp(newsArticles.publishedAt, new Date(startMs).toISOString()));
    const scored = rows.filter(r => typeof r.sentimentScore === 'number');

    if (scored.length === 0) {
      return res.json({ ok: true, available: false, reason: 'No scored real news articles in the last 7 days.', data: [] });
    }

    const byDate = new Map<string, { sum: number; count: number }>();
    for (const r of scored) {
      const dateKey = r.publishedAt.slice(0, 10); // YYYY-MM-DD
      const bucket = byDate.get(dateKey) || { sum: 0, count: 0 };
      bucket.sum += r.sentimentScore as number;
      bucket.count += 1;
      byDate.set(dateKey, bucket);
    }

    let spyByDate = new Map<string, number>();
    try {
      await historicalDataGateway.ensureBars('SPY', '1Day', startMs, now);
      const spyBars = await historicalDataGateway.getBars('SPY', '1Day', startMs, now);
      spyByDate = new Map(spyBars.map(b => [new Date(b.timestamp).toISOString().slice(0, 10), b.close]));
    } catch (e) {
      // Real SPY bars unavailable (no Alpaca credentials, fetch failure) - the sentiment series
      // above still stands on its own; the benchmark overlay is just omitted, never fabricated.
    }

    const data = Array.from(byDate.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, { sum, count }]) => ({
        date,
        sentiment: Number((sum / count).toFixed(1)),
        articleCount: count,
        index: spyByDate.get(date) ?? null,
      }));

    res.json({ ok: true, available: true, data });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==========================================================================================
// Phase 1A (Remediation Verification Pass) - real execution-quality distribution, replacing
// ExecutionQualityChart.tsx's `Date.now() % 1000`-jittered fabricated scatter data.
//
// Execution SPEED (submittedAt -> filledAt, both real timestamps OrderManagementService/
// TransactionLifecycleTracker persist through the real order lifecycle - Section 17.1) is fully
// real and computed here. SLIPPAGE (expected price at proposal time vs. actual fill price) is
// deliberately NOT included: trades.price is overwritten with the real fill price once an order
// is accepted (OrderManagement.ts), and neither `trades` nor `risk_assessments` persists the
// price RiskEngine actually evaluated the proposal against - so there is no real value to plot,
// and fabricating one would be exactly the theater this pass exists to remove. Real `quantity`/
// `side` are plotted instead, which is a real, honest question ("does size correlate with fill
// speed?") this data can actually answer. Adding real slippage tracking would need a schema
// change (persisting the proposal-time price) - a real, separate follow-up, not done here.
// ==========================================================================================
v2Router.get('/trading/execution-quality', async (req, res) => {
  try {
    const days = 30;
    const startIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const rows = await db.select().from(trades)
      .where(andOp(eq(trades.status, 'FILLED'), gteOp(trades.timestamp, startIso)))
      .orderBy(desc(trades.timestamp))
      .limit(200);

    const withTiming = rows.filter(r => r.submittedAt && r.filledAt);

    if (withTiming.length === 0) {
      return res.json({ ok: true, available: false, reason: 'No FILLED trades with both submittedAt and filledAt recorded in the last 30 days.', data: [] });
    }

    const data = withTiming.map(r => ({
      id: r.id,
      symbol: r.symbol,
      side: r.side,
      speedMs: new Date(r.filledAt as string).getTime() - new Date(r.submittedAt as string).getTime(),
      quantity: r.quantity,
      timestamp: r.timestamp,
    })).filter(d => d.speedMs >= 0); // a negative value would mean corrupt/out-of-order timestamps, not a real measurement

    if (data.length === 0) {
      return res.json({ ok: true, available: false, reason: 'FILLED trades exist but none have a valid (non-negative) submit-to-fill duration.', data: [] });
    }

    res.json({ ok: true, available: true, data });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==========================================================================================
// Phase 1A follow-up (Remediation Verification Pass, same house pattern as sentiment-trend and
// execution-quality above) - real per-agent efficiency, replacing TradeEfficiencyReport.tsx's
// 5 hardcoded, fictional "strategies" (Momentum/Mean Revert/News Arb/Order Flow/Macro - none of
// which are real Argus agents or a real, separately-tracked strategy) whose slippage/latency
// values were re-jittered every 4s client-side via Date.now() % 1000 noise, never backed by any
// real measurement.
//
// winRate comes from the same real agent_performance_stats.winRate AgentEvaluationDashboard.tsx
// (an already-confirmed-real tab) reads via /api/v2/agents/performance - not a second,
// independently-computed number. avgLatencyMs is a real average of agent_predictions.latencyMs,
// which is genuinely null for TechnicalAgent/KronosForecastAgent (no LLM call made - deterministic
// local math/local inference service, per schema.ts's own comment) and real for
// NewsAgent/FundamentalAgent/MacroAgent's AI-escalated predictions. An agent with no real logged
// latency reports avgLatencyMs:null (rendered as "N/A" by the frontend) rather than 0 or a
// fabricated figure. `available:false` (not an empty 200) is returned only if no real value at
// all - neither a win rate nor a latency - exists for any of the five real agents.
// ==========================================================================================
v2Router.get('/agents/efficiency', async (req, res) => {
  try {
    const [statsRows, predictionRows] = await Promise.all([
      db.select().from(agentPerformanceStats),
      db.select().from(agentPredictions),
    ]);

    const statsByAgent = new Map(statsRows.map(s => [s.agentName, s]));
    const latencySum = new Map<string, number>();
    const latencyCount = new Map<string, number>();
    for (const p of predictionRows) {
      if (!(REAL_AGENT_NAMES as readonly string[]).includes(p.agentName)) continue;
      if (typeof p.latencyMs !== 'number') continue;
      latencySum.set(p.agentName, (latencySum.get(p.agentName) || 0) + p.latencyMs);
      latencyCount.set(p.agentName, (latencyCount.get(p.agentName) || 0) + 1);
    }

    const data = REAL_AGENT_NAMES.map(agentName => {
      const stat = statsByAgent.get(agentName);
      const count = latencyCount.get(agentName) || 0;
      const avgLatencyMs = count > 0 ? Number((latencySum.get(agentName)! / count).toFixed(0)) : null;
      // ChiefTraderAgent.syncWeights() seeds a placeholder row (totalPredictions:0, winRate:0) for
      // every agent purely so consensus has an initial weight to use - that is NOT a real
      // evaluated win rate. Only treat winRate as real once ReflectionEngine has actually scored
      // at least one real prediction (totalPredictions > 0).
      const hasRealWinRate = !!stat && stat.totalPredictions > 0;
      return {
        agentName,
        winRate: hasRealWinRate ? Number((stat!.winRate * 100).toFixed(1)) : null,
        totalPredictions: stat?.totalPredictions ?? 0,
        avgLatencyMs,
      };
    });

    const anyReal = data.some(d => d.winRate !== null || d.avgLatencyMs !== null);
    if (!anyReal) {
      return res.json({ ok: true, available: false, reason: 'No real agent performance stats or AI-call latency recorded yet.', data: [] });
    }

    res.json({ ok: true, available: true, data });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==========================================================================================
// Real token consumption + cost projection, replacing Settings & Keys' "Token Consumption &
// Projected Costs" panel - previously a hardcoded mockTokenConsumptionData array (6 invented
// agent names, e.g. "OrderFlowAgent"/"SentimentAgent" that do not exist in this codebase) plus a
// literal `$65.42` compared against the user's real alert threshold as if it were live.
//
// Real source: the ai_calls forensic ledger (AIRouter.ts's logAiCall()) already records `agent`,
// `tokensIn`, `tokensOut`, and `cost` per real call. A call is bucketed "local" (free) vs "paid"
// by its real recorded cost being exactly 0 - matching how AIRouter/OpenAICompatibleProvider
// already price local endpoints (Ollama/Chronos) at $0, not a second, separately-maintained
// classification. `projectedCycleCost` extrapolates the real average daily cost over the window
// to 30 days - an honest, disclosed projection method, not a fabricated number; it is exactly
// $0 if every real call so far has been free, never a placeholder non-zero figure.
// ==========================================================================================
v2Router.get('/ai/token-consumption', async (req, res) => {
  try {
    const days = 14;
    const startIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const rows = await db.select().from(aiCallsTable).where(gteOp(aiCallsTable.createdAt, startIso));

    if (rows.length === 0) {
      return res.json({ ok: true, available: false, reason: `No real AI calls recorded in the last ${days} days.`, data: [], totals: null });
    }

    const byAgent = new Map<string, { localTokens: number; paidTokens: number }>();
    let totalCost = 0;
    let totalLocalTokens = 0;
    let totalPaidTokens = 0;

    for (const r of rows) {
      const tokens = (r.tokensIn || 0) + (r.tokensOut || 0);
      const isLocal = (r.cost || 0) === 0;
      const bucket = byAgent.get(r.agent) || { localTokens: 0, paidTokens: 0 };
      if (isLocal) { bucket.localTokens += tokens; totalLocalTokens += tokens; }
      else { bucket.paidTokens += tokens; totalPaidTokens += tokens; }
      byAgent.set(r.agent, bucket);
      totalCost += r.cost || 0;
    }

    const data = Array.from(byAgent.entries()).map(([agent, t]) => ({ agent, ...t }));
    const projectedCycleCost = Number(((totalCost / days) * 30).toFixed(2));

    res.json({
      ok: true, available: true, data,
      totals: {
        localTokens: totalLocalTokens, paidTokens: totalPaidTokens,
        totalCostLastNDays: Number(totalCost.toFixed(2)), windowDays: days,
        projectedCycleCost,
      },
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==========================================================================================
// Real "Opportunity Feed", replacing the Opportunity Feed tab's 3 hardcoded cards (NVDA/TSLA/
// RIVN, invented "Regime: Bullish Trending"/"Algorithm: XGBoost & Agent Swarm"/fake Expected
// Return/Risk Score figures, and a "LIVE SCAN ACTIVE" badge with no fetch behind it at all).
//
// Real source: recent, non-HOLD, high-confidence agent_predictions from the five real agents.
// No "expected return"/"risk score"/"regime" is fabricated to fill the old card's shape - only
// fields with a genuine source are returned (agent, symbol, prediction, confidence, reasoning,
// timestamp). `available:false` when nothing in the window clears the confidence floor.
// ==========================================================================================
const OPPORTUNITY_MIN_CONFIDENCE = tradingSafety.minStrategyConfidenceToTrade;
const OPPORTUNITY_WINDOW_HOURS = runtimeIntervals.opportunityWindowHours;

v2Router.get('/opportunities', async (req, res) => {
  try {
    const sinceIso = new Date(Date.now() - OPPORTUNITY_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
    const rows = await db.select().from(agentPredictions).where(gteOp(agentPredictions.timestamp, sinceIso));

    const data = rows
      .filter(r => (REAL_AGENT_NAMES as readonly string[]).includes(r.agentName))
      .filter(r => r.prediction !== 'HOLD' && r.confidence >= OPPORTUNITY_MIN_CONFIDENCE)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 20)
      .map(r => ({
        symbol: r.symbol,
        agent: r.agentName,
        prediction: r.prediction,
        confidence: Number((r.confidence * 100).toFixed(1)),
        reasoning: r.reasoning,
        timestamp: r.timestamp,
      }));

    if (data.length === 0) {
      return res.json({ ok: true, available: false, reason: `No real agent prediction in the last ${OPPORTUNITY_WINDOW_HOURS}h cleared the ${OPPORTUNITY_MIN_CONFIDENCE * 100}% confidence floor.`, data: [] });
    }

    res.json({ ok: true, available: true, data });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==========================================================================================
// Real portfolio risk attribution by sector/symbol, replacing RiskAttributionTreemap.tsx's fixed
// 5-entry array of invented per-agent risk percentages ("Macro Sentiment", "Order Flow", "News
// Interpreter", "Risk Verifier" - none of which are real Argus agents, and static: no fetch, no
// state update, ever). There is no real per-agent risk-attribution metric anywhere in this
// codebase's schema (agent_performance_stats has no such column, and no trade->originating-agent
// weight is persisted at the granularity needed). What IS real: current portfolio notional
// exposure per symbol, grouped by real GICS-mapped sector via the same PositionSizing.ts
// SECTOR_MAP/getSector() RiskEngine's own sector-concentration gate uses - not a second,
// independently-maintained sector map. Symbols with no sector mapping are honestly grouped under
// "Other", never silently dropped or given a fabricated sector.
// ==========================================================================================
v2Router.get('/portfolio/risk-attribution', async (req, res) => {
  try {
    const holdings = await db.select().from(portfolio).all();
    const withValue = holdings
      .map(h => ({ symbol: h.symbol, value: Math.abs((h.quantity || 0) * (h.currentPrice || 0)) }))
      .filter(h => h.value > 0);

    if (withValue.length === 0) {
      return res.json({ ok: true, available: false, reason: 'No open real positions in the portfolio.', data: [] });
    }

    const totalValue = withValue.reduce((s, h) => s + h.value, 0);
    const bySector = new Map<string, { symbol: string; value: number; pct: number }[]>();
    for (const h of withValue) {
      const sector = getSector(h.symbol) || 'Other';
      const list = bySector.get(sector) || [];
      list.push({ symbol: h.symbol, value: Number(h.value.toFixed(2)), pct: Number(((h.value / totalValue) * 100).toFixed(1)) });
      bySector.set(sector, list);
    }

    const data = Array.from(bySector.entries()).map(([sector, symbols]) => ({
      sector,
      value: Number(symbols.reduce((s, x) => s + x.value, 0).toFixed(2)),
      pct: Number(symbols.reduce((s, x) => s + x.pct, 0).toFixed(1)),
      symbols,
    }));

    res.json({ ok: true, available: true, totalValue: Number(totalValue.toFixed(2)), data });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==========================================================================================
// Real portfolio stress-test calculator, replacing Holdings & Positions' "Portfolio Stress
// Testing" panel - previously produced the IDENTICAL "Affected Sectors: Technology, Consumer
// Cyclical" and the same 3 hardcoded "Guardrail Action Plan" bullets (none of which correspond
// to any real automated response Argus takes) regardless of which of the 4 scenario buttons was
// clicked. "Projected Drawdown" was already honestly "No Data" - this closes that gap for real
// rather than filling it with a fabricated number.
//
// Deliberately does NOT hardcode a shock magnitude per named scenario (e.g. "CPI Spike = -3%") -
// three of the four scenario cards' own descriptions never state an equity-impact percentage, so
// inventing one would be exactly the fabrication this pass exists to remove. Instead this is a
// real what-if calculator: the caller supplies `shockPct` explicitly (the frontend defaults it to
// -10 only for "Flash Crash", since that scenario's own card text already states "-10% overall
// market cap" - not a new invented number), and every other number returned is real: current real
// portfolio notional value/sector exposure (same computation as /portfolio/risk-attribution), the
// real projected dollar impact of applying that user-supplied shock, and a real check against
// RiskEngine's own configured portfolio_drawdown gate (real settings.maxPortfolioDrawdownPct and
// real settings.peakEquity) - answering "would this actually trip the real circuit breaker?"
// with real thresholds, not a hardcoded "ARMED & RESPONSIVE" string.
// ==========================================================================================
v2Router.get('/portfolio/stress-test', async (req, res) => {
  try {
    const shockPct = Number(req.query.shockPct);
    if (!Number.isFinite(shockPct) || shockPct > 0 || shockPct < -100) {
      return res.status(400).json({ ok: false, error: 'shockPct must be a real negative number between -100 and 0 (percent).' });
    }

    const holdings = await db.select().from(portfolio).all();
    const withValue = holdings
      .map(h => ({ symbol: h.symbol, value: Math.abs((h.quantity || 0) * (h.currentPrice || 0)) }))
      .filter(h => h.value > 0);

    if (withValue.length === 0) {
      return res.json({ ok: true, available: false, reason: 'No open real positions in the portfolio.', data: null });
    }

    const totalValue = withValue.reduce((s, h) => s + h.value, 0);
    const projectedLoss = Number((totalValue * (shockPct / 100)).toFixed(2));
    const projectedValue = Number((totalValue + projectedLoss).toFixed(2));

    const sectorSet = new Set<string>();
    for (const h of withValue) sectorSet.add(getSector(h.symbol) || 'Other');

    const settingsRows = await db.select().from(settings).limit(1);
    const maxDrawdownPct = settingsRows[0]?.maxPortfolioDrawdownPct ?? 0.15;
    const peakEquity = settingsRows[0]?.peakEquity ?? null;

    let wouldTripDrawdownGate: boolean | null = null;
    let drawdownGateDetail = 'Real peak equity has not been observed yet (settings.peakEquity is null) - the real portfolio_drawdown gate has no baseline to compare against yet.';
    if (peakEquity !== null && peakEquity > 0) {
      const projectedDrawdownFromPeak = Math.max(0, (peakEquity - projectedValue) / peakEquity);
      wouldTripDrawdownGate = projectedDrawdownFromPeak >= maxDrawdownPct;
      drawdownGateDetail = `Projected ${(projectedDrawdownFromPeak * 100).toFixed(1)}% drawdown from real peak equity ($${peakEquity.toLocaleString()}) vs. the real configured ${(maxDrawdownPct * 100).toFixed(0)}% limit.`;
    }

    res.json({
      ok: true, available: true,
      data: {
        shockPct, totalValue, projectedLoss, projectedValue,
        affectedSectors: Array.from(sectorSet),
        maxPortfolioDrawdownPct: maxDrawdownPct,
        wouldTripDrawdownGate, drawdownGateDetail,
      },
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==========================================================================================
// Real P&L attribution by symbol, replacing StrategyProfitSunburst.tsx's fabricated hierarchy
// (invented sub-strategies like "Whipsaw"/"Pairs Trading"/"Fee Drag" under fictional groups
// "Momentum"/"Mean Reversion"/"Arbitrage" - none of which are real Argus strategies), whose
// dollar values were re-randomized on every render via Date.now() % 1000 jitter.
//
// Real source: trades.profitLoss, populated only for real FILLED SELL orders (OrderManagement.ts
// computes it from the real entry price vs. real fill price - see CLAUDE.md/OrderManagement.ts).
// There is no real per-"strategy" breakdown anywhere in this codebase (Argus has agents, not
// separately-tracked named sub-strategies) - grouping by real symbol is what real data can
// actually answer. horizon filters by real trade timestamp; a symbol with zero real realized P&L
// in the window is simply absent, never a fabricated zero-but-present entry.
// ==========================================================================================
const PNL_HORIZON_DAYS: Record<string, number> = { '1W': 7, '1M': 30, 'YTD': 366 };

v2Router.get('/portfolio/pnl-by-symbol', async (req, res) => {
  try {
    const horizon = (req.query.horizon as string) || '1M';
    const days = PNL_HORIZON_DAYS[horizon] ?? PNL_HORIZON_DAYS['1M'];
    const startIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const rows = await db.select().from(trades)
      .where(andOp(eq(trades.status, 'FILLED'), gteOp(trades.timestamp, startIso)));

    const withPnl = rows.filter(r => typeof r.profitLoss === 'number');
    if (withPnl.length === 0) {
      return res.json({ ok: true, available: false, reason: `No real FILLED trades with realized P&L in the ${horizon} window.`, data: [] });
    }

    const bySymbol = new Map<string, number>();
    for (const r of withPnl) {
      bySymbol.set(r.symbol, (bySymbol.get(r.symbol) || 0) + (r.profitLoss as number));
    }

    const data = Array.from(bySymbol.entries()).map(([symbol, pnl]) => ({
      symbol, pnl: Number(pnl.toFixed(2)), type: pnl >= 0 ? 'profit' : 'loss',
    }));

    res.json({ ok: true, available: true, horizon, data });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==========================================================================================
// Real learning-loop summary, replacing the Learning & Evolution tab's entirely fabricated
// content: hardcoded "Mistakes Corrected: 14"/"Models Retrained: 3"/"Alpha Generated by RL:
// +$2.4k" (no real RL system exists anywhere in this codebase), a "PER-STRATEGY SCORECARD" table
// of invented strategy names ("Trend-Following", "Political Intel") with fixed numbers, a fake
// "Weight Evolution" bar chart, a fabricated "Kelly Position-Sizing Learner" (RiskEngine uses
// real gate-based sizing via PositionSizing.ts, not a Kelly criterion), and a fully scripted
// "Post-Trade Post-Mortem" pipeline narrative (a fake NVDA short/stop-loss story).
//
// Real source: agent_performance_stats (currentWeight/winRate - the actual real feedback loop
// that exists, per ChiefTraderAgent/ReflectionEngine, distinct from any RL claim) and
// learned_rules (ReflectionEngine's real LLM-generated rule text). Recent rule text is truncated
// into ChiefTrader's adversarial debate prompt only; it never overrides RiskEngine. The frontend
// must not imply the rules autonomously retrain models or size positions.
// ==========================================================================================
v2Router.get('/agents/learning-summary', async (req, res) => {
  try {
    const [statsRows, ruleRows] = await Promise.all([
      db.select().from(agentPerformanceStats),
      db.select().from(learnedRules).orderBy(desc(learnedRules.timestamp)).limit(20),
    ]);

    const statsByAgent = new Map(statsRows.map(s => [s.agentName, s]));
    const agentWeights = REAL_AGENT_NAMES.map(agentName => {
      const stat = statsByAgent.get(agentName);
      const hasRealHistory = !!stat && stat.totalPredictions > 0;
      return {
        agentName,
        currentWeight: stat ? Number(stat.currentWeight.toFixed(3)) : null,
        winRate: hasRealHistory ? Number((stat!.winRate * 100).toFixed(1)) : null,
        totalPredictions: stat?.totalPredictions ?? 0,
      };
    });

    res.json({
      ok: true,
      agentWeights,
      recentLearnedRules: ruleRows.map(r => ({ agent: r.agent, cause: r.cause, rule: r.rule, confidence: r.confidence, timestamp: r.timestamp })),
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==========================================================================================
// Additive quant layer observability - real read access to the previously-invisible
// quant_assessments/quant_strategy_backtests tables (QuantSignalAgent.ts, BacktestEngine.ts's
// runStrategyBacktest()). Before this, the only way to see this real, tested capability's output
// was to query SQLite directly - no route, no UI, anywhere in the codebase read it.
// ==========================================================================================
v2Router.get('/desk/intelligence', (_req, res) => {
  res.json({
    ok: true,
    defaultDecision: 'NO_TRADE',
    liveIdeaGenerationEnabled: isLiveIdeaGenerationEnabled(),
    newsEmitsTradeIdeas: deskIntelligence.newsEmitsTradeIdeas,
    minRiskRewardRatio: deskIntelligence.minRiskRewardRatio,
    noTradeReasons: noTradeReasonsConfig.reasons,
    recentCatalysts: listRecentNewsCatalysts(15),
    regimeFamilyRelevance: deskIntelligence.regimeFamilyRelevance,
  });
});

v2Router.get('/system/startup-health', async (_req, res) => {
  try {
    const { collectStartupHealth } = await import('../core/StartupHealthRegistry');
    const services = await collectStartupHealth();
    res.json({ ok: true, services });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

v2Router.get('/markets/canada', async (_req, res) => {
  const { canadianMarketReadiness } = await import('../markets/canadianReadiness');
  res.json({ ok: true, ...canadianMarketReadiness() });
});

v2Router.get('/desk/lifecycle', async (_req, res) => {
  try {
    const { listRecentLifecycle } = await import('../core/TradeLifecycleStore');
    const rows = await listRecentLifecycle(80);
    res.json({
      ok: true,
      available: rows.length > 0,
      summary: rows.length === 0 ? 'NO HISTORICAL DATA' : undefined,
      transitions: rows,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

v2Router.get('/quant/strategies', (req, res) => {
  const mapStrategy = (s: typeof ALL_STRATEGIES[number]) => ({
    id: s.id,
    displayName: s.displayName,
    applicableRegimes: s.applicableRegimes,
    typicalHoldingPeriod: STRATEGY_TYPICAL_HOLDING_PERIOD[s.id] ?? null,
  });
  res.json({
    ok: true,
    strategies: ALL_STRATEGIES.map(mapStrategy),
    experimentalStrategies: EXPERIMENTAL_STRATEGIES.map(s => ({
      ...mapStrategy(s),
      enabledInLiveQuant: isExperimentalStrategyLive(s.id),
      validationStatus: 'UNVALIDATED',
      note: experimentalStrategyRow(s.id)?.apiNote ?? 'Experimental. Not in live Quant evaluateAll unless its config env var is true.',
    })),
    taxonomy: quantStrategyTaxonomySummary(),
  });
});

v2Router.get('/quant/assessments/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const rows = await db.select().from(quantAssessments).where(eq(quantAssessments.symbol, symbol)).orderBy(desc(quantAssessments.createdAt)).limit(20);

    if (rows.length === 0) {
      return res.json({
        ok: true, available: false,
        reason: `No real quant assessments recorded yet for ${symbol} - QuantSignalAgent is off by default (QUANT_ENGINE_ENABLED) or hasn't evaluated this symbol yet.`,
        data: [],
      });
    }

    res.json({
      ok: true, available: true,
      data: rows.map(r => ({
        id: r.id, symbol: r.symbol, timeframe: r.timeframe, createdAt: r.createdAt,
        regime: JSON.parse(r.regime),
        marketContext: JSON.parse(r.marketContext),
        strategyEvaluations: r.strategyEvaluations ? JSON.parse(r.strategyEvaluations) : null,
        groupedScores: r.groupedScores ? JSON.parse(r.groupedScores) : null,
        aiContradictionAnalysis: r.aiContradictionAnalysis ? JSON.parse(r.aiContradictionAnalysis) : null,
        emittedTradeIdea: r.emittedTradeIdea,
      })),
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

v2Router.get('/quant/strategy-backtests', async (req, res) => {
  try {
    const rows = await db.select().from(quantStrategyBacktests).orderBy(desc(quantStrategyBacktests.createdAt)).limit(50);
    res.json({
      ok: true,
      // Summary fields only (no tradeLog/equityCurve) - keeps the list payload small; the detail
      // route below returns the full real trade-by-trade record for one specific run.
      data: rows.map(r => ({
        id: r.id, strategyId: r.strategyId, symbol: r.symbol, timeframe: r.timeframe,
        startDate: r.startDate, endDate: r.endDate, status: r.status, errorMessage: r.errorMessage,
        initialCash: r.initialCash, finalEquity: r.finalEquity, totalTrades: r.totalTrades,
        winRatePct: r.winRatePct, profitFactor: r.profitFactor, sharpe: r.sharpe, sortino: r.sortino,
        maxDrawdownPct: r.maxDrawdownPct, expectancy: r.expectancy,
        avgWinR: r.avgWinR, avgLossR: r.avgLossR, avgR: r.avgR, maxConsecutiveLosses: r.maxConsecutiveLosses,
        regimeBreakdown: r.regimeBreakdown ? JSON.parse(r.regimeBreakdown) : null,
        expectedValue: r.expectedValue ? JSON.parse(r.expectedValue) : null,
        kelly: r.kelly ? JSON.parse(r.kelly) : null,
        createdAt: r.createdAt,
      })),
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

v2Router.get('/quant/strategy-backtests/:id', async (req, res) => {
  try {
    const run: any = await backtestEngine.getStrategyRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Strategy backtest run not found.' });
    const tradeLog = run.tradeLog ? JSON.parse(run.tradeLog) : [];
    res.json({
      ok: true,
      data: {
        ...run,
        regimeBreakdown: run.regimeBreakdown ? JSON.parse(run.regimeBreakdown) : null,
        expectedValue: run.expectedValue ? JSON.parse(run.expectedValue) : null,
        kelly: run.kelly ? JSON.parse(run.kelly) : null,
        tradeLog,
        equityCurve: run.equityCurve ? JSON.parse(run.equityCurve) : [],
        // E4 - recomputed from the persisted tradeLog on every read, never a second stored copy.
        failureBreakdown: computeFailureBreakdown(tradeLog),
        // E7 - persisted at run time (raw bars aren't archived, so this can't be recomputed later).
        benchmarkComparison: run.benchmarkComparison ? JSON.parse(run.benchmarkComparison) : null,
      },
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Real, on-demand trigger for a per-strategy/per-regime backtest (Phase 10) - rate-limited the
// same as the existing /system/backtest trigger, since both run a real, potentially-slow
// historical replay.
v2Router.post('/quant/strategy-backtests', backtestLimiter, async (req, res) => {
  try {
    const { strategyId, symbol, startDate, endDate, timeframe, initialCash, verboseLogging } = req.body || {};
    if (!strategyId || !symbol || !startDate || !endDate) {
      return res.status(400).json({ ok: false, error: 'strategyId, symbol, startDate, and endDate are required.' });
    }
    const result = await backtestEngine.runStrategyBacktest({ strategyId, symbol, startDate, endDate, timeframe, initialCash, verboseLogging: !!verboseLogging });
    res.json({ ok: true, data: result });
  } catch (e: any) {
    const { diagnosticFromBacktestError } = await import('../diagnostics/buildDiagnostic');
    res.status(400).json({ ok: false, error: e.message, diagnostic: diagnosticFromBacktestError(e.message) });
  }
});

// E6 (BACKTEST_QUANT_HARDENING_ANALYSIS.md) - bootstrap-resamples the REAL closed-trade
// R-multiples from an already-completed strategy-backtest run. Always returns
// scenarioAnalysis:true and never writes anything - a pure, on-demand research computation, never
// a stored "prediction". riskPerTradePct/initialCapital/simulations are caller-supplied so this
// can be re-run for different account sizes without re-running the underlying backtest.
// Deliberately NOT behind backtestLimiter - unlike a real backtest, this is cheap in-memory
// resampling over data that's already been computed, not a slow historical replay.
v2Router.post('/quant/strategy-backtests/:id/monte-carlo', async (req, res) => {
  try {
    const run: any = await backtestEngine.getStrategyRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Strategy backtest run not found.' });
    const tradeLog = run.tradeLog ? JSON.parse(run.tradeLog) : [];
    const rMultiples = tradeLog.filter((t: any) => t.side === 'SELL' && typeof t.rMultiple === 'number').map((t: any) => t.rMultiple);

    const { initialCapital, riskPerTradePct, pathLength, simulations } = req.body || {};
    if (typeof initialCapital !== 'number' || initialCapital <= 0) {
      return res.status(400).json({ ok: false, error: 'initialCapital (positive number) is required.' });
    }
    if (typeof riskPerTradePct !== 'number' || riskPerTradePct <= 0) {
      return res.status(400).json({ ok: false, error: 'riskPerTradePct (positive fraction, e.g. 0.02) is required.' });
    }

    const result = runMonteCarlo({ rMultiples, initialCapital, riskPerTradePct, pathLength, simulations });
    res.json({ ok: true, data: result });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// E3 (BACKTEST_QUANT_HARDENING_ANALYSIS.md) - the per-candidate decision trace for a single
// strategy-backtest run, only populated when that run was triggered with verboseLogging:true.
// An empty array is a real, honest answer (either the run had zero BUY candidates, or it wasn't
// triggered with verbose logging) - never fabricated.
v2Router.get('/quant/strategy-backtests/:id/decision-log', async (req, res) => {
  try {
    const rows = await db.select().from(quantBacktestDecisionLog)
      .where(eq(quantBacktestDecisionLog.backtestRunId, req.params.id))
      .orderBy(quantBacktestDecisionLog.timestamp);
    res.json({
      ok: true,
      data: rows.map((r: any) => ({
        ...r,
        conditionsMet: r.conditionsMet ? JSON.parse(r.conditionsMet) : [],
        conditionsFailed: r.conditionsFailed ? JSON.parse(r.conditionsFailed) : [],
        contradictions: r.contradictions ? JSON.parse(r.contradictions) : [],
        sizingGates: r.sizingGates ? JSON.parse(r.sizingGates) : null,
      })),
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Phase 9, Stage B (ARGUS_PRE_IMPLEMENTATION_BASELINE.md / ARGUS_AI_VALIDATION_REPORT.md) - real,
// per-agent statistical validation of live predictions against real subsequent price outcomes
// (PredictionOutcomeEvaluator's own real point-in-time bars-based evaluation). An agent with zero
// evaluated predictions yet is honestly absent from the response, never a fabricated zero row.
v2Router.get('/ai/prediction-validation', async (req, res) => {
  try {
    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    const { computeAIPredictionValidation } = await import('../services/AIPredictionValidation');
    const data = await computeAIPredictionValidation(since);
    res.json({ ok: true, data });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Phase 10 (ARGUS_PRE_IMPLEMENTATION_BASELINE.md / ARGUS_PAPER_TRADING_VALIDATION.md) - real
// aggregation over this app's own real trades/transactions/risk_assessments/reconciliation_events
// tables. Honestly reports statisticallyMeaningful:false (with a real reason) below a real sample
// floor, rather than presenting a handful of fills as a track record.
v2Router.get('/paper-trading/report', async (req, res) => {
  try {
    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    const { computePaperTradingReport } = await import('../services/PaperTradingValidation');
    const data = await computePaperTradingReport(since);
    res.json({ ok: true, data });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

v2Router.get('/orchestration/models', async (_req, res) => {
  try {
    const { modelRuntimeManager } = await import('../ai/ModelRuntimeManager');
    const models = await modelRuntimeManager.refresh();
    res.json({ ok: true, models });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

v2Router.get('/orchestration/capital', async (_req, res) => {
  try {
    const { snapshotCapital } = await import('../engines/CapitalAllocation');
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const { tradingEngine } = await import('../engines/TradingEngine');
    const settingsRows = await db.select().from(settings).limit(1);
    const allocated = Number(settingsRows[0]?.budget ?? tradingEngine.state.budget ?? 0);
    const broker = BrokerManager.getInstance().getActiveBroker();
    let pf: any;
    try {
      pf = await broker.portfolio();
    } catch (e: any) {
      return res.json({
        ok: true,
        available: false,
        what: 'BROKER DATA UNAVAILABLE',
        why: e?.message ?? String(e),
        impact: 'Argus will not substitute fake equity, cash, or P&L. RiskEngine still refuses invalid equity.',
        howToFix: 'Restore broker API connectivity (keys, network, 2FA, permissions, rate limits).',
        argus: snapshotCapital({ allocated: Number.isFinite(allocated) ? allocated : 0, positions: [], pendingBuys: [] }),
      });
    }
    const allTrades = await db.select().from(trades);
    const pendingBuys = (allTrades || []).filter((t: any) =>
      t.side === 'BUY' && t.status && !['FILLED', 'REJECTED', 'CANCELED', 'CANCELLED'].includes(t.status)
    );
    const argus = snapshotCapital({
      allocated: Number.isFinite(allocated) ? allocated : 0,
      positions: pf.positions || [],
      pendingBuys,
    });
    let openOrders = 0;
    try {
      const orders = await broker.orders();
      openOrders = (orders || []).filter((o: any) => o.status && !['FILLED', 'REJECTED', 'CANCELED', 'CANCELLED'].includes(String(o.status).toUpperCase())).length;
    } catch {
      openOrders = pendingBuys.length;
    }
    const invested = (pf.positions || []).reduce((s: number, p: any) => {
      const qty = Number(p.quantity) || 0;
      const px = Number(p.averagePrice ?? p.avgPrice ?? 0) || 0;
      return s + qty * px;
    }, 0);
    res.json({
      ok: true,
      available: true,
      broker: {
        equity: pf.equity,
        cash: pf.cash,
        buyingPower: pf.buyingPower,
        investedCapital: invested,
        unrealizedPnl: pf.unrealizedPnl ?? null,
        realizedPnl: pf.realizedPnl ?? null,
        dailyPnl: pf.dailyPnl ?? null,
        openPositions: (pf.positions || []).length,
        openOrders,
      },
      argus,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

v2Router.get('/diagnostics', async (_req, res) => {
  try {
    const { collectDiagnostics } = await import('../diagnostics/DiagnosticService');
    const snap = await collectDiagnostics();
    res.json({ ok: true, ...snap });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

v2Router.get('/diagnostics/why-not-trading', async (_req, res) => {
  try {
    const { collectDiagnostics } = await import('../diagnostics/DiagnosticService');
    const snap = await collectDiagnostics();
    res.json({ ok: true, ...snap.whyNotTrading, timestamp: snap.timestamp });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

v2Router.get('/diagnostics/why/:id', async (req, res) => {
  try {
    const assembled = await assembleTransaction(req.params.id);
    if (!assembled) {
      return res.status(404).json({
        ok: false,
        available: false,
        reason: 'No transaction row exists for this id. Nothing is fabricated.',
      });
    }
    const { explainTransaction } = await import('../diagnostics/DiagnosticService');
    const explanation = await explainTransaction(assembled);
    res.json({ ok: true, ...explanation });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

v2Router.post('/diagnostics/retry/:component', async (req, res) => {
  try {
    const component = String(req.params.component || '').toLowerCase();
    if (['chronos', 'kronos', 'ollama', 'openalice', 'models'].includes(component)) {
      const { modelRuntimeManager } = await import('../ai/ModelRuntimeManager');
      const models = await modelRuntimeManager.retryUnhealthy();
      return res.json({ ok: true, action: 're-probed', models });
    }
    if (component === 'market_data' || component === 'market-data') {
      const { marketDataWorker: mdw } = await import('../services/MarketDataWorker');
      const status = mdw.reconnect();
      return res.json({
        ok: true,
        action: 'reconnect',
        ...status,
        note: 'Re-opened the Alpaca market-data WebSocket. This does not bypass RiskEngine; data_freshness still requires a fresh tick.',
      });
    }
    res.status(400).json({ ok: false, error: `Retry is not defined for ${component}` });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

v2Router.get('/replay/ai-availability', async (_req, res) => {
  try {
    const { aiHistoricalReplayAvailability } = await import('../replay/aiReplayAvailability');
    res.json({ ok: true, data: aiHistoricalReplayAvailability() });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

v2Router.post('/replay/historical', backtestLimiter, async (req, res) => {
  try {
    const { runHistoricalReplay } = await import('../replay/HistoricalReplayService');
    const data = await runHistoricalReplay(req.body || {});
    res.json(data);
  } catch (e: any) {
    const { diagnosticFromBacktestError } = await import('../diagnostics/buildDiagnostic');
    res.status(400).json({ ok: false, error: e.message, diagnostic: diagnosticFromBacktestError(e.message) });
  }
});
