import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('strategyReadiness', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./strategyReadiness');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_strategy_readiness_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./strategyReadiness');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  function seedGraded(strategyReasoning: string, ts: number, outcome: 'WIN' | 'LOSS', idSuffix: string) {
    const id = `pred-strat-${idSuffix}`;
    return Promise.all([
      db.insert(schema.agentPredictions).values({
        id, agentName: 'QuantEngine', symbol: 'SREADY', prediction: 'BUY', confidence: 0.7,
        reasoning: strategyReasoning, timestamp: new Date(ts).toISOString(),
      }),
      db.insert(schema.predictionOutcomes).values({
        predictionId: id, sourceTable: 'agent_predictions', symbol: 'SREADY',
        actualPrice: 101, actualReturn: 0.01, actualDirection: 'UP',
        mfe: 0.01, mae: 0, outcome, evaluatedAt: new Date(ts).toISOString(),
      }),
    ]);
  }

  it('lists all 5 CORE strategies as implemented/enabled/reachable even with zero real observations, tagged NEVER_EMITTED', async () => {
    const rows = await mod.buildStrategyReadinessReport();
    expect(rows.length).toBe(5);
    const ids = new Set(rows.map((r) => r.strategyId));
    expect(ids.has('MOMENTUM_BREAKOUT')).toBe(true);
    expect(ids.has('PULLBACK_CONTINUATION')).toBe(true);
    expect(ids.has('MEAN_REVERSION')).toBe(true);
    expect(ids.has('TREND_FOLLOWING')).toBe(true);
    expect(ids.has('RANGE_REVERSION')).toBe(true);
    for (const r of rows) {
      expect(r.implemented).toBe(true);
      expect(r.enabled).toBe(true);
      expect(r.reachable).toBe(true);
      expect(r.variant).toBe('NEVER_EMITTED');
      expect(r.status).toBe('NEVER_EMITTED');
    }
  });

  it('shows a separate EV_BACKED row once a real, non-bootstrap strategy-sourced idea is graded', async () => {
    const base = new Date('2026-08-10T09:00:00.000Z').getTime();
    await seedGraded('QuantEngine/MOMENTUM_BREAKOUT: setupScore 0.8, confidence 0.75.', base, 'WIN', 'ev1');

    const rows = await mod.buildStrategyReadinessReport();
    const momentum = rows.find((r) => r.strategyId === 'MOMENTUM_BREAKOUT' && r.variant === 'EV_BACKED')!;
    expect(momentum).toBeDefined();
    expect(momentum.rawN).toBe(1);
  });

  it('shows a SEPARATE COLD_START_BOOTSTRAP row for the same strategy - never merged with the EV-backed row', async () => {
    const base = new Date('2026-08-11T09:00:00.000Z').getTime();
    await seedGraded(
      'QuantEngine: BULLISH_TREND regime... Cold-start bootstrap: MOMENTUM_BREAKOUT is COLD_START (zero real closed trades), so no EV/stop/target backs this idea - operator-enabled via QUANT_COLD_START_BOOTSTRAP_ENABLED.',
      base, 'LOSS', 'boot1',
    );

    const rows = await mod.buildStrategyReadinessReport();
    const evBacked = rows.find((r) => r.strategyId === 'MOMENTUM_BREAKOUT' && r.variant === 'EV_BACKED')!;
    const bootstrap = rows.find((r) => r.strategyId === 'MOMENTUM_BREAKOUT' && r.variant === 'COLD_START_BOOTSTRAP')!;
    expect(evBacked).toBeDefined();
    expect(bootstrap).toBeDefined();
    expect(evBacked.rawN).toBe(1); // unchanged from the previous test - never contaminated by the bootstrap row
    expect(bootstrap.rawN).toBe(1);
  });

  it('formatStrategyReadinessReport renders a readable text table', async () => {
    const rows = await mod.buildStrategyReadinessReport();
    const text = mod.formatStrategyReadinessReport(rows);
    expect(text).toContain('STRATEGY READINESS');
    expect(text).toContain('MOMENTUM_BREAKOUT');
  });

  it('includes a currently-enabled EXPERIMENTAL strategy (isCore:false), not just the 5 CORE ones - real gap fixed (Phase 11, 2026-08-31): a live .env check found all 16 experimental strategies enabled in production, but this report previously only ever covered the 5 hardcoded CORE ids, silently omitting 16 real, currently-live strategies from the activation matrix', async () => {
    const before = await mod.buildStrategyReadinessReport();
    expect(before.find((r) => r.strategyId === 'OSCILLATOR_MOMENTUM')).toBeUndefined();

    process.env.QUANT_OSCILLATOR_MOMENTUM_ENABLED = 'true';
    try {
      const rows = await mod.buildStrategyReadinessReport();
      expect(rows.length).toBe(before.length + 1); // exactly one new row: the newly-enabled experimental strategy
      const oscillator = rows.find((r) => r.strategyId === 'OSCILLATOR_MOMENTUM')!;
      expect(oscillator).toBeDefined();
      expect(oscillator.isCore).toBe(false);
      const momentum = rows.find((r) => r.strategyId === 'MOMENTUM_BREAKOUT')!;
      expect(momentum.isCore).toBe(true);
    } finally {
      delete process.env.QUANT_OSCILLATOR_MOMENTUM_ENABLED;
    }
  });
});
