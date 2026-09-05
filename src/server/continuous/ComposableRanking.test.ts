import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  computeDeterministicComponents,
  computeFinalScore,
  rankCandidates,
  type ComponentSet,
  type RankingWeights,
} from './ComposableRanking';

const WEIGHTS: RankingWeights = {
  momentum: 1, relativeVolume: 1, rangeExpansion: 0.5, gap: 0.5, liquidity: 0.5,
  newsCatalyst: 1, agentConfidence: 0.5, javaQuantScore: 1,
};

describe('computeDeterministicComponents', () => {
  it('computes real momentum/relativeVolume/rangeExpansion/gap/liquidity from available snapshot fields', () => {
    const c = computeDeterministicComponents({
      symbol: 'AAPL', last: 150, prevClose: 145, open: 148, prevOpen: 144,
      minuteHigh: 151, minuteLow: 149, minuteClose: 150,
      dailyVolume: 40_000_000, prevDayVolume: 30_000_000,
      rawMomentumPct: 3.45, rawRelativeVolume: 1.5, rawRangeExpansion: 0.02,
    });
    expect(c.momentum.available).toBe(true);
    expect(c.momentum.score).toBeGreaterThan(0);
    expect(c.relativeVolume.available).toBe(true);
    expect(c.gap.available).toBe(true);
    expect(c.liquidity.available).toBe(true);
    expect(c.liquidity.score).toBeGreaterThan(0);
  });

  it('marks gap unavailable (not zero) when no open price was fetched - never fabricates the missing field', () => {
    const c = computeDeterministicComponents({
      symbol: 'ZZZZ', last: 10, prevClose: 9.5, open: null, prevOpen: null,
      minuteHigh: null, minuteLow: null, minuteClose: null,
      dailyVolume: 1000, prevDayVolume: 900,
      rawMomentumPct: 5, rawRelativeVolume: 1, rawRangeExpansion: 0,
    });
    expect(c.gap.available).toBe(false);
    expect(c.gap.score).toBeNull();
    expect(c.gap.reason).toMatch(/no open price/i);
  });

  it('marks liquidity unavailable when no daily volume was fetched', () => {
    const c = computeDeterministicComponents({
      symbol: 'ZZZZ', last: 10, prevClose: 9.5, open: 9.6, prevOpen: 9.4,
      minuteHigh: null, minuteLow: null, minuteClose: null,
      dailyVolume: null, prevDayVolume: null,
      rawMomentumPct: 5, rawRelativeVolume: 1, rawRangeExpansion: 0,
    });
    expect(c.liquidity.available).toBe(false);
    expect(c.liquidity.score).toBeNull();
  });

  it('clamps extreme momentum/volume to 1.0 rather than an unbounded score', () => {
    const c = computeDeterministicComponents({
      symbol: 'MEME', last: 100, prevClose: 50, open: 90, prevOpen: 48,
      minuteHigh: 110, minuteLow: 90, minuteClose: 100,
      dailyVolume: 999_000_000, prevDayVolume: 1_000_000,
      rawMomentumPct: 100, rawRelativeVolume: 999, rawRangeExpansion: 5,
    });
    expect(c.momentum.score).toBe(1);
    expect(c.relativeVolume.score).toBe(1);
    expect(c.rangeExpansion.score).toBe(1);
  });
});

function fullComponentSet(overrides: Partial<ComponentSet>): ComponentSet {
  const base: ComponentSet = {
    momentum: { score: 0.5, available: true },
    relativeVolume: { score: 0.5, available: true },
    rangeExpansion: { score: 0.5, available: true },
    gap: { score: 0.5, available: true },
    liquidity: { score: 0.5, available: true },
    newsCatalyst: { score: null, available: false, reason: 'no cluster' },
    agentConfidence: { score: null, available: false, reason: 'no prediction' },
    javaQuantScore: { score: null, available: false, reason: 'not requested' },
  };
  return { ...base, ...overrides };
}

describe('computeFinalScore', () => {
  it('excludes unavailable components from both numerator and denominator', () => {
    const components = fullComponentSet({});
    const { finalScore, weightsUsed } = computeFinalScore(components, WEIGHTS);
    expect(weightsUsed.newsCatalyst).toBeUndefined();
    expect(weightsUsed.agentConfidence).toBeUndefined();
    // All available components are 0.5, so the weighted average of available components is 0.5.
    expect(finalScore).toBeCloseTo(0.5, 5);
  });

  it('a symbol with fewer available components is not penalized relative to one with full data, given equal scores', () => {
    const fullData = fullComponentSet({ newsCatalyst: { score: 0.5, available: true }, agentConfidence: { score: 0.5, available: true } });
    const partialData = fullComponentSet({});
    const full = computeFinalScore(fullData, WEIGHTS);
    const partial = computeFinalScore(partialData, WEIGHTS);
    expect(full.finalScore).toBeCloseTo(partial.finalScore, 5);
  });

  it('returns 0 (not NaN) when every component is unavailable', () => {
    const components = fullComponentSet({
      momentum: { score: null, available: false, reason: 'x' },
      relativeVolume: { score: null, available: false, reason: 'x' },
      rangeExpansion: { score: null, available: false, reason: 'x' },
      gap: { score: null, available: false, reason: 'x' },
      liquidity: { score: null, available: false, reason: 'x' },
    });
    const { finalScore } = computeFinalScore(components, WEIGHTS);
    expect(finalScore).toBe(0);
    expect(Number.isNaN(finalScore)).toBe(false);
  });
});

describe('rankCandidates', () => {
  it('sorts by finalScore descending and assigns sequential ranks', () => {
    const scored = [
      { symbol: 'LOW', components: fullComponentSet({}), finalScore: 0.2, weightsUsed: {} },
      { symbol: 'HIGH', components: fullComponentSet({}), finalScore: 0.9, weightsUsed: {} },
      { symbol: 'MID', components: fullComponentSet({}), finalScore: 0.5, weightsUsed: {} },
    ];
    const ranked = rankCandidates(scored, new Map(), 0.75, 0.25);
    expect(ranked.map((r) => r.symbol)).toEqual(['HIGH', 'MID', 'LOW']);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('computes rank delta against the previous cycle', () => {
    const scored = [
      { symbol: 'RISER', components: fullComponentSet({}), finalScore: 0.9, weightsUsed: {} },
      { symbol: 'FALLER', components: fullComponentSet({}), finalScore: 0.3, weightsUsed: {} },
    ];
    const previousRanks = new Map([['RISER', 5], ['FALLER', 1]]);
    const ranked = rankCandidates(scored, previousRanks, 0.75, 0.25);
    const riser = ranked.find((r) => r.symbol === 'RISER')!;
    const faller = ranked.find((r) => r.symbol === 'FALLER')!;
    expect(riser.previousRank).toBe(5);
    expect(riser.rank).toBe(1);
    expect(riser.rankDelta).toBe(4); // moved up 4 places
    expect(faller.rankDelta).toBe(-1); // moved down 1 place
  });

  it('reports null previousRank/rankDelta for a symbol seen for the first time', () => {
    const scored = [{ symbol: 'NEW', components: fullComponentSet({}), finalScore: 0.6, weightsUsed: {} }];
    const ranked = rankCandidates(scored, new Map(), 0.75, 0.25);
    expect(ranked[0].previousRank).toBeNull();
    expect(ranked[0].rankDelta).toBeNull();
  });

  it('classifies PROMOTE / HOLD / REJECT against the given thresholds', () => {
    const scored = [
      { symbol: 'A', components: fullComponentSet({}), finalScore: 0.9, weightsUsed: {} },
      { symbol: 'B', components: fullComponentSet({}), finalScore: 0.5, weightsUsed: {} },
      { symbol: 'C', components: fullComponentSet({}), finalScore: 0.1, weightsUsed: {} },
    ];
    const ranked = rankCandidates(scored, new Map(), 0.75, 0.25);
    expect(ranked.find((r) => r.symbol === 'A')!.promotionRecommendation).toBe('PROMOTE');
    expect(ranked.find((r) => r.symbol === 'B')!.promotionRecommendation).toBe('HOLD');
    expect(ranked.find((r) => r.symbol === 'C')!.promotionRecommendation).toBe('REJECT');
  });
});

describe('fetchNewsCatalystScores / fetchAgentConfidenceScores (DB-backed)', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `argus-ranking-${Date.now()}-${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
  });

  afterEach(() => {
    delete process.env.ARGUS_DB_PATH;
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* */ }
    }
  });

  it('finds a real news catalyst score for a symbol mentioned in a recent cluster, and marks others unavailable', async () => {
    vi.resetModules();
    const { db } = await import('../db');
    const { newsClusters: table } = await import('../db/schema');
    const { fetchNewsCatalystScores } = await import('./ComposableRanking');

    await db.insert(table).values({
      id: 'nc-1', title: 'Real catalyst', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      impactScore: 0.8, symbols: JSON.stringify(['AAPL']),
    });

    const result = await fetchNewsCatalystScores(['AAPL', 'MSFT'], 60 * 60 * 1000);
    expect(result.get('AAPL')?.available).toBe(true);
    expect(result.get('AAPL')?.score).toBeCloseTo(0.8, 5);
    expect(result.get('MSFT')?.available).toBe(false);
  });

  it('fetchNewsCatalystDetails returns real eventType/sourceCount, taking the highest-impact cluster per symbol', async () => {
    vi.resetModules();
    const { db } = await import('../db');
    const { newsClusters: table } = await import('../db/schema');
    const { fetchNewsCatalystDetails } = await import('./ComposableRanking');

    await db.insert(table).values([
      { id: 'nc-lo', title: 'minor', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), impactScore: 0.3, symbols: JSON.stringify(['AAPL']), eventType: 'analyst_action', sourceCount: 1 },
      { id: 'nc-hi', title: 'earnings beat', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), impactScore: 0.9, symbols: JSON.stringify(['AAPL']), eventType: 'earnings', sourceCount: 5 },
    ]);

    const result = await fetchNewsCatalystDetails(['AAPL', 'MSFT'], 60 * 60 * 1000);
    expect(result.get('AAPL')).toEqual({ eventType: 'earnings', sourceCount: 5, impactScore: 0.9 }); // higher-impact cluster wins
    expect(result.get('MSFT')).toBeUndefined();
  });

  it('finds the most recent agent prediction confidence per symbol, marking symbols with no prediction unavailable', async () => {
    vi.resetModules();
    const { db } = await import('../db');
    const { agentPredictions: table } = await import('../db/schema');
    const { fetchAgentConfidenceScores } = await import('./ComposableRanking');

    const now = new Date();
    await db.insert(table).values({
      id: 'ap-1', agentName: 'TechnicalAgent', symbol: 'NVDA', prediction: 'BUY',
      confidence: 0.7, reasoning: 'x', timestamp: now.toISOString(),
    });

    const result = await fetchAgentConfidenceScores(['NVDA', 'SPY'], 60 * 60 * 1000);
    expect(result.get('NVDA')?.available).toBe(true);
    expect(result.get('NVDA')?.score).toBeCloseTo(0.7, 5);
    expect(result.get('SPY')?.available).toBe(false);
  });
});

describe('fetchJavaQuantScores', () => {
  afterEach(() => {
    vi.doUnmock('../services/QuantCoreBridge');
    vi.resetModules();
  });

  const fakeBars = [{ timestamp: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }] as any;

  it('computes a real magnitude score from a positive composite, clamped to [0,1]', async () => {
    vi.resetModules();
    vi.doMock('../services/QuantCoreBridge', () => ({
      quantCoreBridge: { fetchInstitutionalFactors: vi.fn(async () => ({ composite: 1.0 })) },
    }));
    const { fetchJavaQuantScores } = await import('./ComposableRanking');
    const result = await fetchJavaQuantScores(new Map([['AAPL', fakeBars]]));
    expect(result.get('AAPL')).toEqual({ score: 0.5, available: true }); // |1.0| / 2.0 scale
  });

  it('takes the magnitude of a negative composite (direction is not a ranking-component concept)', async () => {
    vi.resetModules();
    vi.doMock('../services/QuantCoreBridge', () => ({
      quantCoreBridge: { fetchInstitutionalFactors: vi.fn(async () => ({ composite: -1.5 })) },
    }));
    const { fetchJavaQuantScores } = await import('./ComposableRanking');
    const result = await fetchJavaQuantScores(new Map([['AAPL', fakeBars]]));
    expect(result.get('AAPL')?.score).toBeCloseTo(0.75, 5); // |-1.5| / 2.0
  });

  it('clamps an extreme composite to 1.0 rather than an unbounded score', async () => {
    vi.resetModules();
    vi.doMock('../services/QuantCoreBridge', () => ({
      quantCoreBridge: { fetchInstitutionalFactors: vi.fn(async () => ({ composite: 50 })) },
    }));
    const { fetchJavaQuantScores } = await import('./ComposableRanking');
    const result = await fetchJavaQuantScores(new Map([['AAPL', fakeBars]]));
    expect(result.get('AAPL')?.score).toBe(1);
  });

  it('marks a symbol unavailable (never a fabricated score) when the Java core returns null', async () => {
    vi.resetModules();
    vi.doMock('../services/QuantCoreBridge', () => ({
      quantCoreBridge: { fetchInstitutionalFactors: vi.fn(async () => null) },
    }));
    const { fetchJavaQuantScores } = await import('./ComposableRanking');
    const result = await fetchJavaQuantScores(new Map([['AAPL', fakeBars]]));
    expect(result.get('AAPL')).toEqual({ score: null, available: false, reason: expect.any(String) });
  });

  it('fails closed to unavailable when the Java bridge call throws', async () => {
    vi.resetModules();
    vi.doMock('../services/QuantCoreBridge', () => ({
      quantCoreBridge: { fetchInstitutionalFactors: vi.fn(async () => { throw new Error('unreachable'); }) },
    }));
    const { fetchJavaQuantScores } = await import('./ComposableRanking');
    const result = await fetchJavaQuantScores(new Map([['AAPL', fakeBars]]));
    expect(result.get('AAPL')?.available).toBe(false);
  });

  it('returns an empty map (zero calls) for an empty input map - the default, zero-added-cost path', async () => {
    vi.resetModules();
    const fetchInstitutionalFactors = vi.fn();
    vi.doMock('../services/QuantCoreBridge', () => ({ quantCoreBridge: { fetchInstitutionalFactors } }));
    const { fetchJavaQuantScores } = await import('./ComposableRanking');
    const result = await fetchJavaQuantScores(new Map());
    expect(result.size).toBe(0);
    expect(fetchInstitutionalFactors).not.toHaveBeenCalled();
  });
});
