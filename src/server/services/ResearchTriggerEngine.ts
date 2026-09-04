/**
 * ResearchTriggerEngine (2026-09-04) - the deterministic "when is research warranted" layer that
 * closes a real architectural gap found during the Phase 3.1 LangGraph verification: every
 * research_agent_runs row that day came from a human manually hitting the research route -
 * nothing in the normal Argus runtime ever invoked LangGraph on its own. This module gives Argus
 * exactly one automatically-triggered, advisory research path.
 *
 * ARGUS OBSERVES -> DETERMINISTIC TRIGGER -> LANGGRAPH INVESTIGATES -> RECOMMENDATION -> HUMAN REVIEW.
 * There is no arrow from this file to ChiefTrader, RiskEngine, OMS, BrokerManager, or any strategy
 * lifecycle/registry mutation - see ResearchTriggerEngine.safetyBoundary.test.ts, which enforces
 * that in code, not just in this comment.
 *
 * The ONE trigger implemented this phase (deliberately not the only one the mission described -
 * see its own Section 13: "do not implement every possible trigger immediately"): a strategy
 * reaching researchTrigger.json's minimumCompletedTrades organic PAPER-only fills since its last
 * automatic research run. Chosen because it is deterministic, requires no speculative regime
 * detection, and is naturally connected to strategy evaluation via the SAME EVENTS.ORDER_EXECUTED
 * event CampaignTracker.ts already listens to for the identical purpose (updating
 * daily_strategy_performance) - reusing an existing, proven hook rather than inventing a new one.
 *
 * Async, non-blocking by construction: this module only ever calls beginStrategyGraduationRun()
 * (Phase 3.1's fast DB-insert-and-return path), never completeStrategyGraduationRun() (the slow
 * LangGraph call) directly - that detached completion is scheduled the same way the HTTP route
 * already does it. A throw anywhere in the ORDER_EXECUTED handler is caught and logged; it can
 * never propagate back into EventBus.emit()'s dispatch loop or affect the trade that just executed
 * (which has already fully happened by the time this listener runs).
 */
import { and, eq, gte, isNotNull, desc } from 'drizzle-orm';
import { db } from '../db';
import { trades, researchAgentRuns } from '../db/schema';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { tradingEngine } from '../engines/TradingEngine';
import { researchTrigger, isResearchTriggerEnabled } from '../config/researchTrigger';
import { isLangGraphResearchEnabled } from '../config/langGraphResearch';
import { beginStrategyGraduationRun, completeStrategyGraduationRun } from './ResearchAgentRunner';
import { structuredLogger, observeSafe } from '../observability/StructuredLogger';

/** Only a real, organic PAPER fill counts as evidence - never REPLAY/HISTORICAL_REPLAY/
 *  TELEMETRY_PULSE/BACKTEST/SIMULATION/ADVISORY_ONLY/EXTERNAL_SYNC/UNKNOWN/etc. An allowlist
 *  (not a blocklist) so a future non-organic executionEnvironment value can never slip through by
 *  omission - see CLAUDE.md's own repeated "not a decision trace" list for why this matters. */
const ORGANIC_EXECUTION_ENVIRONMENT = 'PAPER';

export interface TradeBatchTriggerDecision {
  eligible: boolean;
  reason: string;
  completedTradesSinceLastResearch?: number;
}

function startOfUtcDayIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/**
 * Pure-ish decision function (one DB read for "last automatic run", one for "trade count since"),
 * exported for direct unit testing of the trigger logic without needing a live EventBus dispatch.
 */
export async function evaluateTradeBatchTrigger(strategyId: string, now: Date = new Date()): Promise<TradeBatchTriggerDecision> {
  if (!isResearchTriggerEnabled() || !isLangGraphResearchEnabled()) {
    return { eligible: false, reason: 'RESEARCH_TRIGGER_DISABLED' };
  }
  if (researchTrigger.requirePaperTrading && tradingEngine.state.tradingMode !== 'PAPER') {
    return { eligible: false, reason: 'NOT_PAPER_TRADING' };
  }

  const lastAutomaticRunRows = await db.select({ createdAt: researchAgentRuns.createdAt })
    .from(researchAgentRuns)
    .where(and(eq(researchAgentRuns.strategyId, strategyId), eq(researchAgentRuns.triggerType, 'TRADE_BATCH')))
    .orderBy(desc(researchAgentRuns.createdAt))
    .limit(1);
  const lastAutomaticRun = lastAutomaticRunRows[0] ?? null;

  const cutoffIso = lastAutomaticRun?.createdAt ?? new Date(0).toISOString();
  if (lastAutomaticRun) {
    const msSinceLastRun = now.getTime() - Date.parse(lastAutomaticRun.createdAt);
    if (Number.isFinite(msSinceLastRun) && msSinceLastRun < researchTrigger.minimumResearchIntervalMs) {
      return { eligible: false, reason: 'COOLDOWN_ACTIVE' };
    }
  }

  const dayStartIso = startOfUtcDayIso(now);
  const [perStrategyToday, globalToday] = await Promise.all([
    db.select({ id: researchAgentRuns.id }).from(researchAgentRuns)
      .where(and(eq(researchAgentRuns.strategyId, strategyId), eq(researchAgentRuns.triggerType, 'TRADE_BATCH'), gte(researchAgentRuns.createdAt, dayStartIso))),
    db.select({ id: researchAgentRuns.id }).from(researchAgentRuns)
      .where(and(eq(researchAgentRuns.triggerType, 'TRADE_BATCH'), gte(researchAgentRuns.createdAt, dayStartIso))),
  ]);
  if (perStrategyToday.length >= researchTrigger.maxAutomaticRunsPerStrategyPerDay) {
    return { eligible: false, reason: 'PER_STRATEGY_DAILY_CAP_REACHED' };
  }
  if (globalToday.length >= researchTrigger.maxGlobalAutomaticRunsPerDay) {
    return { eligible: false, reason: 'GLOBAL_DAILY_CAP_REACHED' };
  }

  const completedTrades = await db.select({ id: trades.id }).from(trades)
    .where(and(
      eq(trades.quantStrategyId, strategyId),
      eq(trades.status, 'FILLED'),
      isNotNull(trades.filledAt),
      gte(trades.filledAt, cutoffIso),
      eq(trades.executionEnvironment, ORGANIC_EXECUTION_ENVIRONMENT),
    ));

  const completedTradesSinceLastResearch = completedTrades.length;
  if (completedTradesSinceLastResearch < researchTrigger.minimumCompletedTrades) {
    return { eligible: false, reason: 'THRESHOLD_NOT_REACHED', completedTradesSinceLastResearch };
  }

  return { eligible: true, reason: 'THRESHOLD_REACHED', completedTradesSinceLastResearch };
}

let started = false;
let orderExecutedHandler: ((order: unknown) => void) | null = null;
/** In-process de-dup for events arriving in the same tick, before a DB row can exist yet to check
 *  against - a real race the DB-only check below cannot close by itself (see the safety test for
 *  the exact scenario). Bounded: cleared entries older than a few minutes never accumulate. */
const recentlyHandledTriggerEventIds = new Map<string, number>();
const RECENT_EVENT_ID_TTL_MS = 5 * 60 * 1000;

function pruneRecentEventIds(now: number): void {
  for (const [id, ts] of recentlyHandledTriggerEventIds) {
    if (now - ts > RECENT_EVENT_ID_TTL_MS) recentlyHandledTriggerEventIds.delete(id);
  }
}

async function handleOrderExecuted(order: unknown): Promise<void> {
  const o = order as Record<string, unknown> | null;
  if (!o || o.status !== 'FILLED') return;
  if (o.executionEnvironment !== ORGANIC_EXECUTION_ENVIRONMENT) return;
  const strategyId = typeof o.quantStrategyId === 'string' ? o.quantStrategyId : null;
  if (!strategyId) return; // unattributed - excluded from this first, deliberately narrow trigger
  const triggerEventId = typeof o.id === 'string' ? o.id : null;
  if (!triggerEventId) return;

  const now = Date.now();
  pruneRecentEventIds(now);
  if (recentlyHandledTriggerEventIds.has(triggerEventId)) {
    observeSafe(() => structuredLogger.info(`Research trigger deduplicated (in-process): ${triggerEventId}`, {
      category: 'SYSTEM', eventType: 'research_trigger_deduplicated', component: 'ResearchTriggerEngine',
    }));
    return;
  }
  recentlyHandledTriggerEventIds.set(triggerEventId, now);

  // DB-level idempotency: a fill event delivered twice (e.g. after a restart replays it) must
  // never create a second research run for the same real-world event.
  const existing = await db.select({ id: researchAgentRuns.id }).from(researchAgentRuns)
    .where(eq(researchAgentRuns.triggerEventId, triggerEventId)).limit(1);
  if (existing.length > 0) {
    observeSafe(() => structuredLogger.info(`Research trigger deduplicated (DB): ${triggerEventId}`, {
      category: 'SYSTEM', eventType: 'research_trigger_deduplicated', component: 'ResearchTriggerEngine', strategyId,
    }));
    return;
  }

  const decision = await evaluateTradeBatchTrigger(strategyId);
  observeSafe(() => structuredLogger.info(`Research trigger evaluated for ${strategyId}: ${decision.reason}`, {
    category: 'SYSTEM',
    eventType: 'research_trigger_evaluated',
    component: 'ResearchTriggerEngine',
    strategyId,
    eligible: decision.eligible,
    reason: decision.reason,
    completedTradesSinceLastResearch: decision.completedTradesSinceLastResearch,
  }));
  if (!decision.eligible) return;

  const evidenceSnapshot = {
    strategyId,
    triggerEventId,
    completedTradesSinceLastResearch: decision.completedTradesSinceLastResearch,
    minimumCompletedTrades: researchTrigger.minimumCompletedTrades,
    evidenceTimestamp: new Date().toISOString(),
  };
  const { runId, correlationId, status } = await beginStrategyGraduationRun({
    strategyId,
    triggerType: 'TRADE_BATCH',
    triggerReason: `Strategy reached ${decision.completedTradesSinceLastResearch} new completed organic paper trades (threshold ${researchTrigger.minimumCompletedTrades}).`,
    triggerEventId,
    evidenceSnapshot,
  });
  observeSafe(() => structuredLogger.info(`Automatic research run created for ${strategyId}: ${runId}`, {
    category: 'SYSTEM', eventType: 'research_run_auto_created', component: 'ResearchTriggerEngine',
    strategyId, runId, correlationId, status,
  }));
  if (status === 'PENDING') {
    // Detached on purpose - same pattern the HTTP route already uses for the manual path. Never
    // awaited here: this handler must return long before LangGraph's own multi-second latency.
    void completeStrategyGraduationRun(runId, correlationId, strategyId).catch((e) => {
      console.error('[ResearchTriggerEngine] completeStrategyGraduationRun failed for an auto-triggered run:', e);
    });
  }
}

export function startResearchTriggerEngine(): void {
  if (started) return;
  started = true;
  orderExecutedHandler = (order: unknown) => {
    void handleOrderExecuted(order).catch((e) => {
      console.error('[ResearchTriggerEngine] handleOrderExecuted failed (trading path unaffected):', e);
    });
  };
  eventBus.on(EVENTS.ORDER_EXECUTED, orderExecutedHandler);
}

export function stopResearchTriggerEngine(): void {
  if (orderExecutedHandler) {
    eventBus.off(EVENTS.ORDER_EXECUTED, orderExecutedHandler);
    orderExecutedHandler = null;
  }
  started = false;
}

export function resetResearchTriggerEngineForTests(): void {
  stopResearchTriggerEngine();
  recentlyHandledTriggerEventIds.clear();
}
