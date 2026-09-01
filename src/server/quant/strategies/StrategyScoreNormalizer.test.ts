import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { StrategyEvaluation } from './types';

function evalFixture(strategy: string, setupScore: number, side: 'BUY' | 'SELL' = 'BUY'): StrategyEvaluation {
  return {
    strategy, side, setupScore, confidence: 0.8, conditionsMet: [], conditionsFailed: [],
    contradictions: [], invalidationConditions: [], stop: { price: 0, reasoning: '' } as any,
    target: { price: 0, reasoning: '' } as any, applicableRegimes: ['BULL_TRENDING'] as any,
  };
}

describe('StrategyScoreNormalizer.computeNormalizedRank (pure, no DB)', () => {
  it('flag-off equivalent: with an empty stats map, every evaluation is thin-sample and falls back to raw setupScore ordering - identical to today\'s behavior', async () => {
    const { computeNormalizedRank } = await import('./StrategyScoreNormalizer');
    const evaluations = [evalFixture('A', 40), evalFixture('B', 90), evalFixture('C', 60)];
    const ranked = computeNormalizedRank(evaluations, new Map(), 20);
    expect(ranked.map((e) => e.strategy)).toEqual(['B', 'C', 'A']); // unchanged: raw setupScore descending
  });

  it('the exact real-world case: a structurally low-scoring strategy with a strong CURRENT setup outranks a structurally high-scoring strategy with a mediocre CURRENT setup', async () => {
    const { computeNormalizedRank } = await import('./StrategyScoreNormalizer');
    // MEAN_REVERSION-like: historical mean 18, stddev 8 - today's 40 is genuinely exceptional for it (z ~2.75).
    // OSCILLATOR_MOMENTUM-like: historical mean 76, stddev 10 - today's 80 is barely above its own average (z ~0.4).
    const stats = new Map([
      ['MEAN_REVERSION_LIKE', { strategyId: 'MEAN_REVERSION_LIKE', mean: 18, stddev: 8, count: 100 }],
      ['OSCILLATOR_LIKE', { strategyId: 'OSCILLATOR_LIKE', mean: 76, stddev: 10, count: 100 }],
    ]);
    const evaluations = [evalFixture('OSCILLATOR_LIKE', 80), evalFixture('MEAN_REVERSION_LIKE', 40)];
    const ranked = computeNormalizedRank(evaluations, stats, 20);
    expect(ranked[0].strategy).toBe('MEAN_REVERSION_LIKE'); // real setup strength, not raw scale, wins
  });

  it('a strategy below the minimum historical sample keeps its raw setupScore rather than an unreliable thin-sample z-score', async () => {
    const { computeNormalizedRank } = await import('./StrategyScoreNormalizer');
    const stats = new Map([
      ['THINSAMPLE', { strategyId: 'THINSAMPLE', mean: 18, stddev: 8, count: 3 }], // below minSample=20
    ]);
    const evaluations = [evalFixture('THINSAMPLE', 90), evalFixture('OTHER', 50)];
    const ranked = computeNormalizedRank(evaluations, stats, 20);
    // THINSAMPLE keeps its raw 90, still beats OTHER's raw 50 (OTHER has no stats entry at all either) - proves the fallback compares on the same scale, not an automatic demotion.
    expect(ranked[0].strategy).toBe('THINSAMPLE');
  });

  it('zero historical variance (every past observation identical) maps to a neutral score, never a fabricated extreme', async () => {
    const { computeNormalizedRank } = await import('./StrategyScoreNormalizer');
    const stats = new Map([
      ['CONSTANT', { strategyId: 'CONSTANT', mean: 50, stddev: 0, count: 50 }],
    ]);
    const evaluations = [evalFixture('CONSTANT', 99), evalFixture('OTHER', 60)];
    const ranked = computeNormalizedRank(evaluations, stats, 20);
    expect(ranked[0].strategy).toBe('OTHER'); // CONSTANT's neutral (50) score loses to OTHER's raw 60, not an artificial win from a 99 input
  });

  it('never mutates the input array', async () => {
    const { computeNormalizedRank } = await import('./StrategyScoreNormalizer');
    const evaluations = [evalFixture('A', 40), evalFixture('B', 90)];
    const originalOrder = evaluations.map((e) => e.strategy);
    computeNormalizedRank(evaluations, new Map(), 20);
    expect(evaluations.map((e) => e.strategy)).toEqual(originalOrder);
  });
});

describe('StrategyScoreNormalizer.refreshStrategyHistoricalStats (real DB integration)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./StrategyScoreNormalizer');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_strategy_normalizer_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../../db'));
    schema = await import('../../db/schema');
    mod = await import('./StrategyScoreNormalizer');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('computes a real mean/stddev/count per strategy from already-persisted quant_assessments.strategyEvaluations rows', async () => {
    const now = new Date().toISOString();
    const rows = [
      { strategy: 'REALSTRAT', setupScore: 10 },
      { strategy: 'REALSTRAT', setupScore: 20 },
      { strategy: 'REALSTRAT', setupScore: 30 },
    ];
    for (const [i, r] of rows.entries()) {
      await db.insert(schema.quantAssessments).values({
        id: `qa-${i}`, symbol: 'AAPL', timeframe: '1Min', regime: '{}', marketContext: '{}',
        strategyEvaluations: JSON.stringify([{ strategy: r.strategy, setupScore: r.setupScore }]),
        emittedTradeIdea: false, createdAt: now,
      });
    }
    const stats = await mod.refreshStrategyHistoricalStats(30);
    const real = stats.get('REALSTRAT');
    expect(real).toBeDefined();
    expect(real!.count).toBe(3);
    expect(real!.mean).toBeCloseTo(20); // (10+20+30)/3
    expect(real!.stddev).toBeCloseTo(8.165, 2); // population stddev of [10,20,30]
  });

  it('the cache is stale until a refresh has run, and getCachedStrategyHistoricalStats never fabricates an entry', async () => {
    expect(mod.isStrategyHistoricalStatsCacheStale()).toBe(false); // just refreshed above
    const cached = mod.getCachedStrategyHistoricalStats();
    expect(cached.get('NEVER_SEEN_STRATEGY')).toBeUndefined();
  });
});
