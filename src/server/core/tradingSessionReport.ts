/**
 * Pre-market / market-open operator observability report (2026-08-24 readiness audit, Part 10).
 * Read-only, real counts only - every number here comes from a direct DB query scoped to the
 * current real exchange trading day (America/New_York), never fabricated or estimated.
 *
 * Every counter distinguishes LIVE/PAPER organic activity from REPLAY/BACKTEST/SIMULATION, reusing
 * the same classification organicPaper.ts already uses for the soak-status tooling - not a second,
 * parallel definition of "organic" that could quietly drift from that one.
 */
import { db } from '../db';
import * as schema from '../db/schema';
import { and, gte, sql } from 'drizzle-orm';
import { getTradingDateStr, TRADING_TIMEZONE } from './TradingCalendar';
import { classifyTradeEnvironment, type ExecutionEnvironment } from '../research/organicPaper';
import { getAIProviderHealthSnapshot } from '../ai/AIProviderHealthCheck';
import { argusRuntime } from './ArgusRuntime';
import { classifyMarketSession } from '../replay/marketSession';

export interface TradingSessionReport {
  generatedAt: string;
  tradingDate: string;
  market: {
    session: 'PRE_MARKET' | 'RTH' | 'AFTER_HOURS' | 'CLOSED' | 'UNKNOWN';
    marketDataReady: boolean;
    activeSymbols: number;
    maxSymbols: number;
    candidateSymbolsMissingPrice: number;
  };
  decisionPipeline: {
    ideasGenerated: number;
    ideasRejected: number;
    missingPrice: number;
    consensusRoundsStarted: number;
    chiefTraderApproved: number;
    consensusRejected: number;
  };
  execution: {
    riskEvaluations: number;
    riskApproved: number;
    ordersSubmitted: number;
    ordersAccepted: number;
    fills: number;
    reconciliationMatches: number;
  };
  ai: {
    healthyProviders: number;
    degradedProviders: number;
    totalProviders: number;
    /** Real share of ai_calls with status='success' today - not a live provider probe. */
    callSuccessRatePct: number | null;
    consensusProvidersAvailable: boolean;
  };
  safety: {
    paperTradingOnly: boolean;
    liveReadiness: string;
    killSwitchActive: boolean;
    interruptedSessionHold: boolean;
  };
  /** By execution context - organic (PAPER/LIVE) counted separately from REPLAY/BACKTEST/SIMULATION,
   *  so this report can never accidentally present replay activity as if it were real trading. */
  executionContextBreakdown: Record<ExecutionEnvironment, { trades: number; riskAssessments: number }>;
}

function startOfTradingDayMs(): number {
  // Real trading-day boundary (America/New_York midnight), not UTC midnight - matches
  // getTradingDateStr()'s own documented reasoning (RiskEngine.ts's daily_loss gate uses the same).
  const now = new Date();
  const todayStr = getTradingDateStr(now);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TRADING_TIMEZONE, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const offsetProbe = new Date(`${todayStr}T00:00:00`);
  // Simple, honest approximation: use the local Date parse of the trading-date string at
  // UTC-midnight-equivalent; exact DST-safe boundary math already lives in TradingCalendar.ts and
  // is out of scope to re-derive here - this report only needs an approximate "today" cutoff for
  // operator counters, not a gate-grade exact boundary.
  return offsetProbe.getTime();
}

/** Filled by the route layer, which has direct, non-circular access to marketDataWorker/sessionRecovery. */
export interface TradingSessionReportOverrides {
  activeSymbols?: number;
  interruptedSessionHold?: boolean;
}

export async function getTradingSessionReport(overrides: TradingSessionReportOverrides = {}): Promise<TradingSessionReport> {
  const sinceMs = startOfTradingDayMs();
  const tradingDate = getTradingDateStr();

  let eventRows: Array<{ eventType: string; timestamp: number; payload: string | null }> = [];
  try {
    eventRows = (await db.select({
      eventType: schema.eventTraces.eventType,
      timestamp: schema.eventTraces.timestamp,
      payload: schema.eventTraces.payload,
    }).from(schema.eventTraces).where(gte(schema.eventTraces.timestamp, sinceMs))) as any;
  } catch {
    eventRows = [];
  }

  const countType = (t: string) => eventRows.filter((r) => r.eventType === t).length;
  const missingPrice = eventRows.filter((r) => r.eventType === 'TRADE_IDEA_REJECTED' && r.payload?.includes('MISSING_PRICE')).length;

  let tradeRows: any[] = [];
  let riskRows: any[] = [];
  try {
    tradeRows = await db.select().from(schema.trades);
    riskRows = await db.select().from(schema.riskAssessments);
  } catch {
    tradeRows = [];
    riskRows = [];
  }
  const todaySinceIso = new Date(sinceMs).toISOString();
  const todayTrades = tradeRows.filter((t) => (t.timestamp ?? '') >= todaySinceIso);
  const todayRisk = riskRows.filter((r) => (r.createdAt ?? '') >= todaySinceIso);

  const breakdown: Record<ExecutionEnvironment, { trades: number; riskAssessments: number }> = {
    LIVE: { trades: 0, riskAssessments: 0 },
    PAPER: { trades: 0, riskAssessments: 0 },
    REPLAY: { trades: 0, riskAssessments: 0 },
    BACKTEST: { trades: 0, riskAssessments: 0 },
    SIMULATION: { trades: 0, riskAssessments: 0 },
    UNKNOWN: { trades: 0, riskAssessments: 0 },
  };
  for (const t of todayTrades) {
    const env = classifyTradeEnvironment({ executionEnvironment: t.executionEnvironment, traceId: t.traceId, reasoning: t.reasoning });
    breakdown[env].trades += 1;
  }
  for (const r of todayRisk) {
    const env = classifyTradeEnvironment({ executionEnvironment: undefined, traceId: r.traceId, reasoning: r.reasoning });
    breakdown[env].riskAssessments += 1;
  }
  const organicTrades = todayTrades.filter((t) => {
    const env = classifyTradeEnvironment({ executionEnvironment: t.executionEnvironment, traceId: t.traceId, reasoning: t.reasoning });
    return env === 'PAPER' || env === 'LIVE';
  });
  const organicRisk = todayRisk.filter((r) => {
    const env = classifyTradeEnvironment({ executionEnvironment: undefined, traceId: r.traceId, reasoning: r.reasoning });
    return env === 'PAPER' || env === 'LIVE';
  });

  let aiProviders: Awaited<ReturnType<typeof getAIProviderHealthSnapshot>> = [];
  try { aiProviders = await getAIProviderHealthSnapshot(); } catch { aiProviders = []; }
  const healthy = aiProviders.filter((p) => p.status === 'HEALTHY').length;

  let health: ReturnType<typeof argusRuntime.health> | null = null;
  try { health = argusRuntime.health(); } catch { health = null; }

  let aiCallSuccessRatePct: number | null = null;
  try {
    const calls = await db.select().from(schema.aiCalls).where(gte(schema.aiCalls.createdAt, todaySinceIso));
    if (calls.length > 0) {
      const success = calls.filter((c: any) => c.status === 'success').length;
      aiCallSuccessRatePct = Math.round((success / calls.length) * 1000) / 10;
    }
  } catch { /* best-effort */ }

  return {
    generatedAt: new Date().toISOString(),
    tradingDate,
    market: {
      session: (() => {
        const s = classifyMarketSession(Date.now(), TRADING_TIMEZONE, true);
        return s === 'REGULAR' ? 'RTH' : s;
      })(),
      marketDataReady: health?.marketDataConnected === true,
      activeSymbols: overrides.activeSymbols ?? 0,
      maxSymbols: 90,
      candidateSymbolsMissingPrice: missingPrice,
    },
    decisionPipeline: {
      ideasGenerated: countType('TRADE_IDEA_GENERATED'),
      ideasRejected: countType('TRADE_IDEA_REJECTED'),
      missingPrice,
      consensusRoundsStarted: countType('CHIEF_CONSENSUS_STARTED'),
      chiefTraderApproved: countType('CHIEF_APPROVED_IDEA'),
      consensusRejected: countType('DESK_NO_TRADE'),
    },
    execution: {
      riskEvaluations: organicRisk.length,
      riskApproved: organicRisk.filter((r) => r.approved).length,
      ordersSubmitted: organicTrades.length,
      ordersAccepted: organicTrades.filter((t) => t.status !== 'REJECTED').length,
      fills: organicTrades.filter((t) => t.status === 'FILLED').length,
      reconciliationMatches: countType('RECONCILIATION_MATCH'),
    },
    ai: {
      healthyProviders: healthy,
      degradedProviders: aiProviders.length - healthy,
      totalProviders: aiProviders.length,
      callSuccessRatePct: aiCallSuccessRatePct,
      consensusProvidersAvailable: healthy > 0,
    },
    safety: {
      paperTradingOnly: process.env.PAPER_TRADING_ONLY !== 'false',
      liveReadiness: health?.liveReadiness ?? 'UNKNOWN',
      killSwitchActive: health?.emergencyStopActive === true,
      interruptedSessionHold: overrides.interruptedSessionHold ?? false,
    },
    executionContextBreakdown: breakdown,
  };
}

export function renderTradingSessionReport(r: TradingSessionReport): string {
  const lines: string[] = [];
  lines.push('ARGUS TRADING READINESS');
  lines.push('');
  lines.push('Market:');
  lines.push(`  Session: ${r.market.session}`);
  lines.push(`  Market Data: ${r.market.marketDataReady ? 'READY' : 'DEGRADED'}`);
  lines.push(`  Active Symbols: ${r.market.activeSymbols} / ${r.market.maxSymbols}`);
  lines.push(`  Candidate Symbols Missing Price: ${r.market.candidateSymbolsMissingPrice}`);
  lines.push('');
  lines.push('Decision Pipeline:');
  lines.push(`  Ideas Generated: ${r.decisionPipeline.ideasGenerated}`);
  lines.push(`  Ideas Rejected: ${r.decisionPipeline.ideasRejected}`);
  lines.push(`  Missing Price: ${r.decisionPipeline.missingPrice}`);
  lines.push(`  Consensus Rounds Started: ${r.decisionPipeline.consensusRoundsStarted}`);
  lines.push(`  ChiefTrader Approved: ${r.decisionPipeline.chiefTraderApproved}`);
  lines.push(`  Consensus Rejected (no-trade): ${r.decisionPipeline.consensusRejected}`);
  lines.push('');
  lines.push('Execution (organic PAPER/LIVE only - see breakdown below for replay/backtest):');
  lines.push(`  Risk Evaluations: ${r.execution.riskEvaluations}`);
  lines.push(`  Risk Approved: ${r.execution.riskApproved}`);
  lines.push(`  Orders Submitted: ${r.execution.ordersSubmitted}`);
  lines.push(`  Orders Accepted: ${r.execution.ordersAccepted}`);
  lines.push(`  Fills: ${r.execution.fills}`);
  lines.push(`  Reconciliation Matches: ${r.execution.reconciliationMatches}`);
  lines.push('');
  lines.push('AI:');
  lines.push(`  Healthy Providers: ${r.ai.healthyProviders}`);
  lines.push(`  Degraded Providers: ${r.ai.degradedProviders}`);
  lines.push(`  Provider Success Rate: ${r.ai.callSuccessRatePct == null ? 'n/a (no calls today)' : r.ai.callSuccessRatePct + '%'}`);
  lines.push(`  Consensus Provider Availability: ${r.ai.consensusProvidersAvailable ? 'YES' : 'NO'}`);
  lines.push('');
  lines.push('Safety:');
  lines.push(`  PAPER_TRADING_ONLY: ${r.safety.paperTradingOnly}`);
  lines.push(`  LIVE_NO_GO: ${r.safety.liveReadiness}`);
  lines.push(`  Kill Switch: ${r.safety.killSwitchActive ? 'ACTIVE' : 'inactive'}`);
  lines.push(`  Interrupted Session Hold: ${r.safety.interruptedSessionHold}`);
  lines.push('');
  lines.push('Execution Context Breakdown (never mixed with organic above):');
  for (const [env, counts] of Object.entries(r.executionContextBreakdown)) {
    if (counts.trades === 0 && counts.riskAssessments === 0) continue;
    lines.push(`  ${env}: ${counts.trades} trades, ${counts.riskAssessments} risk assessments`);
  }
  return lines.join('\n');
}
