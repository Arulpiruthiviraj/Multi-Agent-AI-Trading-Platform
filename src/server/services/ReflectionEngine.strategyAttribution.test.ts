import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * 2026-09-11 - strategy-level attribution gap. QuantEngine's real emitTradeIdea call
 * (QuantSignalAgent.ts) already carried the winning strategy id (e.g. 'MOMENTUM_BREAKOUT')
 * nested in quantDetail.strategyEvaluation.strategy, but ReflectionEngine.logPrediction()
 * never read it - every QuantEngine row collapsed to agent_name='QuantEngine' with no way to
 * tell which of the 5 CORE (or experimental) strategies actually produced a given prediction.
 * agent_predictions.strategy_id closes that gap; must stay null (never fabricated) for agents
 * that don't carry this shape.
 *
 * Corrected 2026-09-13 (Master Transformation Mandate Part 7 audit): a live production DB query
 * found strategy_id populated on ZERO of 6,249 real QuantEngine rows, despite the fix above -
 * quantDetail.strategyEvaluation is deliberately nulled by QuantSignalAgent.ts's cold-start-
 * bootstrap path (the path essentially every real QuantEngine idea takes today, per CLAUDE.md's
 * own "organic closed PAPER FILLED SELL P&L: 0"), so the field this test's first case checks was
 * never actually populated in production. QuantSignalAgent.ts now also emits a dedicated
 * top-level `strategyId` (resolvedStrategyId, captured before the nulling) that ReflectionEngine
 * prefers - the new test below covers exactly the real bug this session found and fixed.
 */
describe('ReflectionEngine - strategy-level attribution (agent_predictions.strategy_id)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let eq: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_reflection_strategyattr_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ eq } = await import('drizzle-orm'));
    await import('./ReflectionEngine');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('persists the real strategy id for a QuantEngine idea carrying quantDetail.strategyEvaluation.strategy', async () => {
    const { eventBus } = await import('../core/EventBus');

    eventBus.emit('TRADE_IDEA_GENERATED', {
      traceId: 'quant-strategy-attr-trace-1',
      symbol: 'AAPL',
      side: 'BUY',
      confidence: 0.78,
      reasoning: 'quant idea',
      agent: 'QuantEngine',
      currentPrice: 190,
      quantDetail: {
        strategyEvaluation: { strategy: 'MOMENTUM_BREAKOUT', side: 'BUY', setupScore: 0.8 },
      },
    });
    await new Promise((r) => setTimeout(r, 50));

    const rows = await db.select().from(schema.agentPredictions)
      .where(eq(schema.agentPredictions.traceId, 'quant-strategy-attr-trace-1')).all();
    expect(rows.length).toBe(1);
    expect(rows[0].strategyId).toBe('MOMENTUM_BREAKOUT');
  });

  it('leaves strategy id null for agents that carry no strategyEvaluation shape (e.g. TechnicalAgent)', async () => {
    const { eventBus } = await import('../core/EventBus');

    eventBus.emit('TRADE_IDEA_GENERATED', {
      traceId: 'technical-no-strategy-trace-1',
      symbol: 'MSFT',
      side: 'SELL',
      confidence: 0.7,
      reasoning: 'RSI overbought',
      agent: 'TechnicalAgent',
      currentPrice: 410,
    });
    await new Promise((r) => setTimeout(r, 50));

    const rows = await db.select().from(schema.agentPredictions)
      .where(eq(schema.agentPredictions.traceId, 'technical-no-strategy-trace-1')).all();
    expect(rows.length).toBe(1);
    expect(rows[0].strategyId).toBeNull();
  });

  it('persists the real strategy id from the dedicated top-level strategyId field even when quantDetail.strategyEvaluation is null (the real cold-start-bootstrap production shape, 2026-09-13 fix)', async () => {
    const { eventBus } = await import('../core/EventBus');

    eventBus.emit('TRADE_IDEA_GENERATED', {
      traceId: 'quant-coldstart-attr-trace-1',
      symbol: 'TSLA',
      side: 'BUY',
      confidence: 0.6,
      reasoning: 'Cold-start bootstrap: TREND_FOLLOWING is COLD_START (zero real closed trades), so no EV/stop/target backs this idea.',
      agent: 'QuantEngine',
      currentPrice: 250,
      strategyId: 'TREND_FOLLOWING', // resolvedStrategyId, captured before quantDetail.strategyEvaluation was nulled
      quantDetail: { regime: 'BULLISH_TREND', strategyEvaluation: null },
    });
    await new Promise((r) => setTimeout(r, 50));

    const rows = await db.select().from(schema.agentPredictions)
      .where(eq(schema.agentPredictions.traceId, 'quant-coldstart-attr-trace-1')).all();
    expect(rows.length).toBe(1);
    expect(rows[0].strategyId).toBe('TREND_FOLLOWING');
  });

  it('leaves strategy id null for a QuantEngine idea whose quantDetail is missing a strategyEvaluation (never fabricated)', async () => {
    const { eventBus } = await import('../core/EventBus');

    eventBus.emit('TRADE_IDEA_GENERATED', {
      traceId: 'quant-no-eval-trace-1',
      symbol: 'NVDA',
      side: 'BUY',
      confidence: 0.76,
      reasoning: 'quant idea, no matched strategy evaluation',
      agent: 'QuantEngine',
      currentPrice: 900,
      quantDetail: { regime: 'BULLISH_TREND' },
    });
    await new Promise((r) => setTimeout(r, 50));

    const rows = await db.select().from(schema.agentPredictions)
      .where(eq(schema.agentPredictions.traceId, 'quant-no-eval-trace-1')).all();
    expect(rows.length).toBe(1);
    expect(rows[0].strategyId).toBeNull();
  });
});
