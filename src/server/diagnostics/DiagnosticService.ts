/**
 * Builds a live diagnostic snapshot from real subsystems. Never reports READY without a probe.
 * Optional models (Chronos/Ollama/OpenAlice) do not set tradingBlocked by themselves.
 */
import { eventBus } from '../core/EventBus';
import { db } from '../db';
import * as schema from '../db/schema';
import { desc } from 'drizzle-orm';
import { tradingEngine } from '../engines/TradingEngine';
import { readMarketClock } from '../engines/RiskEngine';
import { marketDataWorker } from '../services/MarketDataWorker';
import { BrokerManager } from '../../brokers/BrokerManager';
import { snapshotCapital } from '../engines/CapitalAllocation';
import { newsEngine } from '../news/NewsEngine';
import { buildDiagnostic } from './buildDiagnostic';
import { GATE_FIX } from './catalog';
import { tradingSafety } from '../config/tradingSafety';
import type { DiagnosticMessage } from './types';
import { chiefTrader } from '../services/ChiefTraderAgent';
import { formatWhyNoTrade, type LastConsensusOutcome } from '../core/consensusExplanation';

const STALE_MS = tradingSafety.stalePriceThresholdMs;
const lastFingerprint = new Map<string, string>();

function emitIfChanged(d: DiagnosticMessage) {
  const fp = `${d.component}|${d.code}|${d.status}|${d.tradingBlocked}|${d.cause}`;
  if (lastFingerprint.get(d.component) === fp) return;
  lastFingerprint.set(d.component, fp);
  eventBus.emit('DIAGNOSTIC_CREATED', d);
    if (d.code === 'MD-001' || d.code === 'MD-005' || d.code === 'MD-006') eventBus.emit('DATA_STALE', d);
  if (d.code === 'MOD-001' || d.code === 'MOD-002' || d.code === 'MOD-004') eventBus.emit('MODEL_UNAVAILABLE', d);
  if (d.code === 'CAP-001') eventBus.emit('CAPITAL_BLOCK', d);
  if (d.code === 'RSK-001') eventBus.emit('RISK_BLOCK', d);
}

export async function collectDiagnostics(): Promise<{
  timestamp: string;
  diagnostics: DiagnosticMessage[];
  whyNotTrading: {
    isTrading: boolean;
    primary: DiagnosticMessage | null;
    blocking: DiagnosticMessage[];
    passing: { component: string; ok: boolean; note: string }[];
    explanation: string | null;
    lastConsensus: LastConsensusOutcome | null;
  };
  capital: any;
}> {
  const diagnostics: DiagnosticMessage[] = [];

  const tradingState = tradingEngine.state.tradingState;
  if (tradingState !== 'TRADING_ENABLED') {
    diagnostics.push(buildDiagnostic('SYS-001', { tradingState }));
  }
  if (tradingEngine.state.enabled !== true) {
    diagnostics.push(buildDiagnostic('SYS-002', { tradingState }));
  }

  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
    diagnostics.push(buildDiagnostic('MD-002', {}));
  } else {
    const feed = marketDataWorker.getFeedStatus();
    const clock = await readMarketClock();
    if (!feed.connected) {
      const rs = feed.readyState;
      const rsLabel = rs === 0 ? 'CONNECTING' : rs === 2 ? 'CLOSING' : rs == null ? 'no socket yet' : 'CLOSED';
      diagnostics.push(buildDiagnostic('MD-005', {
        thresholdSeconds: STALE_MS / 1000,
        cause: feed.lastError
          ? `Alpaca keys are set. WebSocket is ${rsLabel}. lastError: ${feed.lastError}`
          : `Alpaca keys are set. WebSocket is ${rsLabel} (not OPEN). The feed starts at process boot even if Autobot is off.`,
      }));
    } else {
      const symbols = marketDataWorker.getActiveSymbols();
      let worstAge: number | null = null;
      let worstSymbol = symbols[0] || 'n/a';
      for (const s of symbols) {
        const age = marketDataWorker.getLatestPriceAgeMs(s);
        if (age == null) continue;
        if (worstAge == null || age > worstAge) { worstAge = age; worstSymbol = s; }
      }
      if (clock === 'closed' || clock === 'unavailable') {
        diagnostics.push(buildDiagnostic('MD-006', {
          clockStatus: clock,
          ageSeconds: worstAge == null ? 'none yet' : Math.round(worstAge / 1000),
        }));
      } else if (worstAge != null && worstAge > STALE_MS) {
        diagnostics.push(buildDiagnostic('MD-001', {
          symbol: worstSymbol,
          ageSeconds: Math.round(worstAge / 1000),
          thresholdSeconds: STALE_MS / 1000,
          cause: 'No MARKET_DATA tick within RiskEngine data_freshness window.',
        }));
      } else {
        diagnostics.push(buildDiagnostic('MD-003', {
          ageSeconds: worstAge == null ? 'no tick yet' : Math.round(worstAge / 1000),
        }));
      }
    }
  }
  diagnostics.push(buildDiagnostic('MD-004', {}));

  if (!process.env.ALPHAVANTAGE_API_KEY) {
    diagnostics.push(buildDiagnostic('CFG-001', {}));
  }

  try {
    const providers = newsEngine.providerManager.getProviders();
    const unconfigured = providers.filter((p: any) => typeof p.isConfigured === 'function' && p.isConfigured() === false);
    for (const p of unconfigured) {
      diagnostics.push(buildDiagnostic('NEWS-002', { provider: p.name || p.id }));
    }
    const articleCount = (await db.select().from(schema.newsArticles).limit(1)).length;
    if (providers.length > 0 && unconfigured.length < providers.length && articleCount === 0) {
      diagnostics.push(buildDiagnostic('NEWS-001', {}));
    }
  } catch (e: any) {
    diagnostics.push(buildDiagnostic('NEWS-002', { provider: 'NewsEngine', technicalMessage: e.message }));
  }

  const { modelRuntimeManager } = await import('../ai/ModelRuntimeManager');
  const models = await modelRuntimeManager.refresh();
  for (const m of models) {
    if (m.modelId === 'chronos-kronos') {
      if (m.health === 'READY') {
        diagnostics.push(buildDiagnostic('MOD-001', { endpoint: m.endpoint, detail: m.detail }, {
          severity: 'INFO', status: 'AVAILABLE', title: 'Chronos/Kronos inference is reachable',
          userMessage: `Health OK at ${m.endpoint} (${m.detail}). Optional forecast provider.`,
          cause: m.detail || 'health ok',
          tradingBlocked: false,
          tradingImpact: 'OPTIONAL. Forecasts may participate as evidence only.',
          canContinueSafely: true,
          recommendedFix: 'None.',
          autoRecoveryStatus: 'not needed',
        }));
      } else {
        diagnostics.push(buildDiagnostic('MOD-001', { endpoint: m.endpoint, detail: m.detail, autoRecoveryStatus: process.env.ARGUS_START_CHRONOS === 'true' ? 'spawn permitted' : 'spawn disabled (probe-only)' }));
      }
    }
    if (m.modelId === 'ollama') {
      if (m.health === 'READY') {
        diagnostics.push(buildDiagnostic('MOD-002', { endpoint: m.endpoint, detail: m.detail }, {
          severity: 'INFO', status: 'AVAILABLE', title: 'Ollama is reachable',
          userMessage: `Ollama answered /api/tags at ${m.endpoint}. ${m.detail}`,
          cause: m.detail || 'ok',
          tradingBlocked: false,
          tradingImpact: 'OPTIONAL local LLM.',
          canContinueSafely: true,
          recommendedFix: 'None.',
        }));
      } else {
        diagnostics.push(buildDiagnostic('MOD-002', { endpoint: m.endpoint, detail: m.detail }));
      }
    }
    if (m.modelId === 'openalice') {
      if (m.health === 'DISABLED') diagnostics.push(buildDiagnostic('MOD-003', { detail: m.detail }));
      else if (m.health !== 'READY') diagnostics.push(buildDiagnostic('MOD-004', { detail: m.detail }));
    }
  }

  let capital: any = null;
  try {
    const settingsRows = await db.select().from(schema.settings).limit(1);
    const allocated = Number(settingsRows[0]?.budget ?? tradingEngine.state.budget ?? 0);
    const broker = BrokerManager.getInstance().getActiveBroker();
    const pf = await broker.portfolio();
    const allTrades = await db.select().from(schema.trades);
    const pendingBuys = (allTrades || []).filter((t: any) =>
      t.side === 'BUY' && t.status && !['FILLED', 'REJECTED', 'CANCELED', 'CANCELLED'].includes(t.status)
    );
    const argus = snapshotCapital({ allocated, positions: pf.positions || [], pendingBuys });
    capital = {
      broker: { equity: pf.equity, cash: pf.cash, buyingPower: pf.buyingPower },
      argus,
    };
  } catch (e: any) {
    diagnostics.push(buildDiagnostic('BRK-001', { detail: `Could not read broker portfolio: ${e.message}` }));
  }

  const lastRisk = await db.select().from(schema.riskAssessments).orderBy(desc(schema.riskAssessments.createdAt)).limit(1);
  if (lastRisk[0] && !lastRisk[0].approved) {
    const gate = lastRisk[0].rejectionGate || 'unknown';
    const when = lastRisk[0].createdAt;
    const liveHalt = gate === 'emergency_stop' && tradingState !== 'TRADING_ENABLED';
    if (liveHalt) {
      // SYS-001 already reports the live kill switch. Do not duplicate it as a second ERROR.
    } else {
      diagnostics.push(buildDiagnostic('RSK-001', {
        gate,
        reasoning: `Last persisted rejection (${when}): ${lastRisk[0].reasoning || gate}. Current tradingState is ${tradingState}. This row is history, not a live bypass.`,
        recommendedFix: GATE_FIX[gate] || 'Inspect the failed gate; do not bypass RiskEngine.',
      }, {
        severity: 'INFO',
        tradingBlocked: false,
        title: 'Last RiskEngine rejection (historical)',
        status: 'EMPTY_RESULT',
      }));
    }
  }

  for (const d of diagnostics) emitIfChanged(d);

  const blocking = diagnostics.filter(d => d.tradingBlocked && d.severity !== 'INFO');
  const primary = blocking.sort((a, b) => {
    const rank = { CRITICAL: 0, ERROR: 1, WARNING: 2, INFO: 3 } as const;
    return rank[a.severity] - rank[b.severity];
  })[0] || null;

  const passing = [
    { component: 'BROKER', ok: !diagnostics.some(d => d.code === 'BRK-001'), note: capital ? `equity $${Number(capital.broker.equity).toFixed(2)}` : 'portfolio unread' },
    { component: 'CAPITAL', ok: !diagnostics.some(d => d.code === 'CAP-001'), note: capital ? `remaining $${Number(capital.argus.remaining).toFixed(2)}` : 'n/a' },
    { component: 'MARKET_DATA', ok: !diagnostics.some(d => (d.code === 'MD-001' || d.code === 'MD-002' || d.code === 'MD-005') && d.tradingBlocked), note: marketDataWorker.isConnected() ? 'WS OPEN' : 'WS not OPEN' },
    { component: 'RISK_ENGINE', ok: tradingState === 'TRADING_ENABLED', note: tradingState },
    { component: 'CHRONOS', ok: !diagnostics.some(d => d.code === 'MOD-001' && d.status === 'UNAVAILABLE'), note: 'optional' },
    { component: 'OLLAMA', ok: !diagnostics.some(d => d.code === 'MOD-002' && d.status === 'UNAVAILABLE'), note: 'optional' },
  ];

  return {
    timestamp: new Date().toISOString(),
    diagnostics,
    whyNotTrading: {
      isTrading: tradingEngine.state.enabled === true && tradingState === 'TRADING_ENABLED' && blocking.length === 0,
      primary,
      blocking,
      passing,
      explanation: formatWhyNoTrade(chiefTrader.getLastConsensusOutcome()),
      lastConsensus: chiefTrader.getLastConsensusOutcome(),
    },
    capital,
  };
}

export async function explainTransaction(assembled: any): Promise<Record<string, unknown>> {
  if (!assembled?.transaction) {
    return { available: false, reason: 'No transaction row exists for this id. Nothing is fabricated.' };
  }
  const t = assembled.transaction;
  const evidence = assembled.evidence || [];
  const risk = assembled.riskAssessment;
  const gates = assembled.riskGates || [];
  const failedGate = gates.find((g: any) => g.passed === false);
  const failedName = failedGate?.gateName || failedGate?.gate;
  const order = assembled.order;
  const isSell = (t.side || order?.side) === 'SELL';
  const approved = !!risk?.approved && (order?.status === 'FILLED' || order?.status === 'PENDING' || order?.status === 'ACCEPTED' || order?.status === 'PARTIALLY_FILLED');

  return {
    available: true,
    question: isSell ? 'WHY DID ARGUS SELL?' : (approved ? 'WHY DID ARGUS TRADE?' : 'WHY DID ARGUS NOT TRADE?'),
    symbol: t.symbol,
    side: t.side,
    status: t.status,
    trigger: evidence[0]?.agent || t.originAgent || null,
    evidence: evidence.map((e: any) => ({
      agent: e.agent, side: e.side, confidence: e.confidence, weight: e.weight,
      reasoning: e.reasoning,
    })),
    chiefTrader: assembled.consensusDecision ? {
      approved: assembled.consensusDecision.approved,
      side: assembled.consensusDecision.side,
      weightedConfidence: assembled.consensusDecision.weightedConfidence,
      reasoning: assembled.consensusDecision.reasoning,
    } : null,
    riskEngine: risk ? {
      approved: risk.approved,
      rejectionGate: risk.rejectionGate,
      reasoning: risk.reasoning,
      failedGate: failedGate ? { gate: failedName, detail: failedGate.detail } : null,
      capitalVsBroker: failedName === 'argus_capital_allocation'
        ? 'Blocked by Argus allocation, not by broker buying power.'
        : null,
    } : { approved: false, reasoning: 'No risk_assessments row for this transaction.' },
    order: order ? { status: order.status, quantity: order.quantity, price: order.price, reasoning: order.reasoning } : null,
    fills: assembled.fills || [],
    events: (assembled.events || []).map((e: any) => ({ type: e.eventType, timestamp: e.timestamp })),
    disclaimer: 'Every field is copied from persisted rows. Missing fields mean the pipeline never wrote them.',
  };
}
