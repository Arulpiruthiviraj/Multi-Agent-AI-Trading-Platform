/**
 * ResearchTriggerEngine (2026-09-04) - the ONE deterministic trigger implemented this phase:
 * a strategy reaching researchTrigger.json's minimumCompletedTrades organic PAPER fills since its
 * last automatic research run. See ResearchTriggerEngine.ts's own header for the full rationale.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { beginStrategyGraduationRun, completeStrategyGraduationRun } = vi.hoisted(() => ({
  beginStrategyGraduationRun: vi.fn(),
  completeStrategyGraduationRun: vi.fn(),
}));
vi.mock('./ResearchAgentRunner', () => ({
  beginStrategyGraduationRun,
  completeStrategyGraduationRun,
}));

import { db } from '../db';
import { trades, researchAgentRuns } from '../db/schema';
import { eq } from 'drizzle-orm';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { tradingEngine } from '../engines/TradingEngine';
import {
  evaluateTradeBatchTrigger,
  startResearchTriggerEngine,
  resetResearchTriggerEngineForTests,
} from './ResearchTriggerEngine';

const FLAG = 'RESEARCH_TRIGGER_ENABLED';
const LG_FLAG = 'LANGGRAPH_RESEARCH_ENABLED';
const STRATEGY = 'MOMENTUM_BREAKOUT';

let tradeCounter = 0;
async function insertFilledPaperTrade(strategyId: string, filledAtIso: string, opts: { executionEnvironment?: string; status?: string } = {}) {
  tradeCounter += 1;
  await db.insert(trades).values({
    id: `trade-${tradeCounter}-${Math.random().toString(36).slice(2)}`,
    symbol: 'AAPL',
    side: 'BUY',
    quantity: 1,
    price: 100,
    status: opts.status ?? 'FILLED',
    timestamp: filledAtIso,
    filledAt: filledAtIso,
    quantStrategyId: strategyId,
    executionEnvironment: opts.executionEnvironment ?? 'PAPER',
  });
}

async function insertAutomaticRun(strategyId: string, createdAtIso: string, triggerEventId = `evt-${Math.random()}`) {
  await db.insert(researchAgentRuns).values({
    id: `run-${Math.random().toString(36).slice(2)}`,
    correlationId: `corr-${Math.random()}`,
    kind: 'STRATEGY_GRADUATION_RECOMMENDATION',
    strategyId,
    requestJson: '{}',
    status: 'COMPLETED',
    createdAt: createdAtIso,
    triggerType: 'TRADE_BATCH',
    triggerEventId,
  });
}

async function cleanupStrategyRows(strategyId: string) {
  await db.delete(trades).where(eq(trades.quantStrategyId, strategyId));
  await db.delete(researchAgentRuns).where(eq(researchAgentRuns.strategyId, strategyId));
}

describe('ResearchTriggerEngine.evaluateTradeBatchTrigger', () => {
  beforeEach(async () => {
    process.env[FLAG] = 'true';
    process.env[LG_FLAG] = 'true';
    tradingEngine.state.tradingMode = 'PAPER';
    await cleanupStrategyRows(STRATEGY);
  });
  afterEach(async () => {
    delete process.env[FLAG];
    delete process.env[LG_FLAG];
    await cleanupStrategyRows(STRATEGY);
  });

  it('is disabled by default (flag off) even with plenty of qualifying trades', async () => {
    delete process.env[FLAG];
    for (let i = 0; i < 25; i++) await insertFilledPaperTrade(STRATEGY, new Date(Date.now() - i * 1000).toISOString());
    const decision = await evaluateTradeBatchTrigger(STRATEGY);
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('RESEARCH_TRIGGER_DISABLED');
  });

  it('is disabled when LangGraph itself is not enabled, even if the trigger flag is on', async () => {
    delete process.env[LG_FLAG];
    for (let i = 0; i < 25; i++) await insertFilledPaperTrade(STRATEGY, new Date(Date.now() - i * 1000).toISOString());
    const decision = await evaluateTradeBatchTrigger(STRATEGY);
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('RESEARCH_TRIGGER_DISABLED');
  });

  it('refuses to trigger outside PAPER trading mode (requirePaperTrading)', async () => {
    tradingEngine.state.tradingMode = 'LIVE';
    for (let i = 0; i < 25; i++) await insertFilledPaperTrade(STRATEGY, new Date(Date.now() - i * 1000).toISOString());
    const decision = await evaluateTradeBatchTrigger(STRATEGY);
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('NOT_PAPER_TRADING');
  });

  it('threshold not reached: fewer than minimumCompletedTrades organic fills', async () => {
    for (let i = 0; i < 5; i++) await insertFilledPaperTrade(STRATEGY, new Date(Date.now() - i * 1000).toISOString());
    const decision = await evaluateTradeBatchTrigger(STRATEGY);
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('THRESHOLD_NOT_REACHED');
    expect(decision.completedTradesSinceLastResearch).toBe(5);
  });

  it('threshold reached: exactly minimumCompletedTrades (20) organic fills triggers eligibility', async () => {
    for (let i = 0; i < 20; i++) await insertFilledPaperTrade(STRATEGY, new Date(Date.now() - i * 1000).toISOString());
    const decision = await evaluateTradeBatchTrigger(STRATEGY);
    expect(decision.eligible).toBe(true);
    expect(decision.reason).toBe('THRESHOLD_REACHED');
    expect(decision.completedTradesSinceLastResearch).toBe(20);
  });

  it('threshold exceeded: well past minimumCompletedTrades still triggers (not capped by the count check itself)', async () => {
    for (let i = 0; i < 50; i++) await insertFilledPaperTrade(STRATEGY, new Date(Date.now() - i * 1000).toISOString());
    const decision = await evaluateTradeBatchTrigger(STRATEGY);
    expect(decision.eligible).toBe(true);
    expect(decision.completedTradesSinceLastResearch).toBe(50);
  });

  it('excludes non-organic executionEnvironment trades (REPLAY/TELEMETRY_PULSE/etc.) from the count', async () => {
    for (let i = 0; i < 25; i++) await insertFilledPaperTrade(STRATEGY, new Date(Date.now() - i * 1000).toISOString(), { executionEnvironment: 'REPLAY' });
    const decision = await evaluateTradeBatchTrigger(STRATEGY);
    expect(decision.eligible).toBe(false);
    expect(decision.completedTradesSinceLastResearch).toBe(0);
  });

  it('excludes non-FILLED trades (PENDING/REJECTED/CANCELED) from the count', async () => {
    for (let i = 0; i < 25; i++) await insertFilledPaperTrade(STRATEGY, new Date(Date.now() - i * 1000).toISOString(), { status: 'PENDING' });
    const decision = await evaluateTradeBatchTrigger(STRATEGY);
    expect(decision.completedTradesSinceLastResearch).toBe(0);
  });

  it('cooldown: a recent automatic run for this strategy blocks a new trigger even with enough trades', async () => {
    await insertAutomaticRun(STRATEGY, new Date().toISOString());
    for (let i = 0; i < 25; i++) await insertFilledPaperTrade(STRATEGY, new Date(Date.now() - i * 1000).toISOString());
    const decision = await evaluateTradeBatchTrigger(STRATEGY);
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('COOLDOWN_ACTIVE');
  });

  it('only counts trades AFTER the last automatic run when the cooldown has elapsed', async () => {
    const longAgo = new Date(Date.now() - 999 * 60 * 60 * 1000).toISOString();
    await insertAutomaticRun(STRATEGY, longAgo);
    // 5 trades before the last run (must not count) + 20 after (must count)
    for (let i = 0; i < 5; i++) await insertFilledPaperTrade(STRATEGY, new Date(Date.parse(longAgo) - (i + 1) * 1000).toISOString());
    for (let i = 0; i < 20; i++) await insertFilledPaperTrade(STRATEGY, new Date(Date.now() - i * 1000).toISOString());
    const decision = await evaluateTradeBatchTrigger(STRATEGY);
    expect(decision.eligible).toBe(true);
    expect(decision.completedTradesSinceLastResearch).toBe(20);
  });

  it('per-strategy daily cap: refuses once maxAutomaticRunsPerStrategyPerDay automatic runs already exist today', async () => {
    // Fixed reference "now" (midday UTC) so the 3 runs are both past cooldown (>4h ago) AND still
    // within the same UTC day-start window the cap check uses - avoids any real-clock flakiness
    // around the UTC day boundary or the cooldown window.
    const fixedNow = new Date('2026-06-15T12:00:00.000Z');
    const pastCooldown = new Date(fixedNow.getTime() - 5 * 60 * 60 * 1000).toISOString(); // 5h ago, same UTC day
    for (let i = 0; i < 3; i++) await insertAutomaticRun(STRATEGY, pastCooldown, `cap-evt-${i}`);
    for (let i = 0; i < 25; i++) await insertFilledPaperTrade(STRATEGY, new Date(fixedNow.getTime() - i * 1000).toISOString());
    const decision = await evaluateTradeBatchTrigger(STRATEGY, fixedNow);
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('PER_STRATEGY_DAILY_CAP_REACHED');
  });

  it('multiple strategies are evaluated independently - one strategy at threshold does not affect another', async () => {
    const OTHER = 'PULLBACK_CONTINUATION';
    await cleanupStrategyRows(OTHER);
    for (let i = 0; i < 20; i++) await insertFilledPaperTrade(STRATEGY, new Date(Date.now() - i * 1000).toISOString());
    for (let i = 0; i < 3; i++) await insertFilledPaperTrade(OTHER, new Date(Date.now() - i * 1000).toISOString());
    const a = await evaluateTradeBatchTrigger(STRATEGY);
    const b = await evaluateTradeBatchTrigger(OTHER);
    expect(a.eligible).toBe(true);
    expect(b.eligible).toBe(false);
    await cleanupStrategyRows(OTHER);
  });
});

describe('ResearchTriggerEngine.handleOrderExecuted (via the real ORDER_EXECUTED event)', () => {
  beforeEach(async () => {
    process.env[FLAG] = 'true';
    process.env[LG_FLAG] = 'true';
    tradingEngine.state.tradingMode = 'PAPER';
    beginStrategyGraduationRun.mockReset();
    completeStrategyGraduationRun.mockReset();
    beginStrategyGraduationRun.mockResolvedValue({ runId: 'r1', correlationId: 'c1', status: 'PENDING' });
    completeStrategyGraduationRun.mockReturnValue(new Promise(() => { /* never resolves during the test */ }));
    resetResearchTriggerEngineForTests();
    await cleanupStrategyRows(STRATEGY);
  });
  afterEach(async () => {
    resetResearchTriggerEngineForTests();
    delete process.env[FLAG];
    delete process.env[LG_FLAG];
    await cleanupStrategyRows(STRATEGY);
  });

  it('never blocks the trading path: emitting ORDER_EXECUTED returns synchronously even though completeStrategyGraduationRun never resolves', async () => {
    startResearchTriggerEngine();
    for (let i = 0; i < 19; i++) await insertFilledPaperTrade(STRATEGY, new Date(Date.now() - i * 1000).toISOString());
    const started = Date.now();
    eventBus.emit(EVENTS.ORDER_EXECUTED, {
      id: 'trigger-trade-1', status: 'FILLED', executionEnvironment: 'PAPER', quantStrategyId: STRATEGY,
    });
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeLessThan(200);
  });

  it('creates exactly one automatic research run when the 20th qualifying fill arrives', async () => {
    startResearchTriggerEngine();
    for (let i = 0; i < 19; i++) await insertFilledPaperTrade(STRATEGY, new Date(Date.now() - i * 1000).toISOString());
    eventBus.emit(EVENTS.ORDER_EXECUTED, {
      id: 'trigger-trade-final', status: 'FILLED', executionEnvironment: 'PAPER', quantStrategyId: STRATEGY,
    });
    await insertFilledPaperTrade(STRATEGY, new Date().toISOString());
    await new Promise((r) => setTimeout(r, 50));
    expect(beginStrategyGraduationRun).toHaveBeenCalledTimes(1);
    const [call] = beginStrategyGraduationRun.mock.calls[0];
    expect(call.strategyId).toBe(STRATEGY);
    expect(call.triggerType).toBe('TRADE_BATCH');
    expect(call.triggerEventId).toBe('trigger-trade-final');
    expect(call.evidenceSnapshot).toBeTruthy();
  });

  it('never triggers on a TELEMETRY_PULSE fill (not organic evidence)', async () => {
    startResearchTriggerEngine();
    for (let i = 0; i < 25; i++) await insertFilledPaperTrade(STRATEGY, new Date(Date.now() - i * 1000).toISOString());
    eventBus.emit(EVENTS.ORDER_EXECUTED, {
      id: 'telemetry-1', status: 'FILLED', executionEnvironment: 'TELEMETRY_PULSE', quantStrategyId: STRATEGY,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(beginStrategyGraduationRun).not.toHaveBeenCalled();
  });

  it('never triggers for an unattributed trade (no quantStrategyId)', async () => {
    startResearchTriggerEngine();
    for (let i = 0; i < 25; i++) await insertFilledPaperTrade(STRATEGY, new Date(Date.now() - i * 1000).toISOString());
    eventBus.emit(EVENTS.ORDER_EXECUTED, {
      id: 'unattributed-1', status: 'FILLED', executionEnvironment: 'PAPER', quantStrategyId: null,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(beginStrategyGraduationRun).not.toHaveBeenCalled();
  });

  it('deduplicates the identical event delivered twice in-process (same triggerEventId)', async () => {
    startResearchTriggerEngine();
    for (let i = 0; i < 25; i++) await insertFilledPaperTrade(STRATEGY, new Date(Date.now() - i * 1000).toISOString());
    const payload = { id: 'dup-trade-1', status: 'FILLED', executionEnvironment: 'PAPER', quantStrategyId: STRATEGY };
    eventBus.emit(EVENTS.ORDER_EXECUTED, payload);
    eventBus.emit(EVENTS.ORDER_EXECUTED, payload);
    await new Promise((r) => setTimeout(r, 50));
    expect(beginStrategyGraduationRun).toHaveBeenCalledTimes(1);
  });

  it('deduplicates against an already-persisted run with the same triggerEventId (DB-level, survives a restart)', async () => {
    await insertAutomaticRun(STRATEGY, new Date(0).toISOString(), 'already-persisted-trade');
    startResearchTriggerEngine();
    for (let i = 0; i < 25; i++) await insertFilledPaperTrade(STRATEGY, new Date(Date.now() - i * 1000).toISOString());
    eventBus.emit(EVENTS.ORDER_EXECUTED, {
      id: 'already-persisted-trade', status: 'FILLED', executionEnvironment: 'PAPER', quantStrategyId: STRATEGY,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(beginStrategyGraduationRun).not.toHaveBeenCalled();
  });

  it('a thrown error inside the handler never escapes to the EventBus dispatch loop', async () => {
    beginStrategyGraduationRun.mockRejectedValue(new Error('simulated failure'));
    startResearchTriggerEngine();
    for (let i = 0; i < 25; i++) await insertFilledPaperTrade(STRATEGY, new Date(Date.now() - i * 1000).toISOString());
    expect(() => {
      eventBus.emit(EVENTS.ORDER_EXECUTED, {
        id: 'failing-trade-1', status: 'FILLED', executionEnvironment: 'PAPER', quantStrategyId: STRATEGY,
      });
    }).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
  });
});
