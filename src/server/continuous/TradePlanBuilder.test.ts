import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildTradePlanDrafts,
  revalidateTradePlan,
  DEFAULT_TRADE_PLAN_THRESHOLDS,
} from './TradePlanBuilder';
import type { RankedCandidate, RankingInput, ComponentSet } from './ComposableRanking';

function availComp(score: number): ComponentSet[keyof ComponentSet] {
  return { score, available: true };
}
function unavailComp(reason: string): ComponentSet[keyof ComponentSet] {
  return { score: null, available: false, reason };
}

function fullComponents(overrides: Partial<ComponentSet> = {}): ComponentSet {
  return {
    momentum: availComp(0.8), relativeVolume: availComp(0.7), rangeExpansion: availComp(0.5),
    gap: availComp(0.4), liquidity: availComp(0.6),
    newsCatalyst: unavailComp('no cluster'), agentConfidence: unavailComp('no prediction'),
    ...overrides,
  };
}

function ranked(symbol: string, rank: number, promotionRecommendation: RankedCandidate['promotionRecommendation'], finalScore = 0.8): RankedCandidate {
  return {
    symbol, components: fullComponents(), finalScore, weightsUsed: {},
    rank, previousRank: null, rankDelta: null, promotionRecommendation,
    promotionReason: 'test',
  };
}

function input(symbol: string, overrides: Partial<RankingInput> = {}): RankingInput {
  return {
    symbol, last: 100, prevClose: 95, open: 96, prevOpen: 94,
    minuteHigh: 101, minuteLow: 99, minuteClose: 100,
    dailyVolume: 10_000_000, prevDayVolume: 8_000_000,
    rawMomentumPct: 5.26, rawRelativeVolume: 1.25, rawRangeExpansion: 0.02,
    ...overrides,
  };
}

describe('buildTradePlanDrafts', () => {
  it('classifies rank 1-3 as PRIMARY, next 5 as BACKUP, next 15 as WATCHLIST', () => {
    const candidates = Array.from({ length: 25 }, (_, i) => ranked(`SYM${i}`, i + 1, 'PROMOTE'));
    const inputs = new Map(candidates.map((c) => [c.symbol, input(c.symbol)]));
    const drafts = buildTradePlanDrafts(candidates, inputs, '2026-08-27');

    const bySymbol = new Map(drafts.map((d) => [d.symbol, d]));
    expect(bySymbol.get('SYM0')!.setupType).toBe('PRIMARY'); // rank 1
    expect(bySymbol.get('SYM2')!.setupType).toBe('PRIMARY'); // rank 3
    expect(bySymbol.get('SYM3')!.setupType).toBe('BACKUP'); // rank 4
    expect(bySymbol.get('SYM7')!.setupType).toBe('BACKUP'); // rank 8
    expect(bySymbol.get('SYM8')!.setupType).toBe('WATCHLIST'); // rank 9
    expect(bySymbol.get('SYM22')!.setupType).toBe('WATCHLIST'); // rank 23
    expect(bySymbol.has('SYM23')).toBe(false); // rank 24, beyond all tiers
  });

  it('never creates a plan for a REJECT-recommended candidate, even if highly ranked', () => {
    const candidates = [ranked('BAD', 1, 'REJECT', 0.1)];
    const inputs = new Map([['BAD', input('BAD')]]);
    const drafts = buildTradePlanDrafts(candidates, inputs, '2026-08-27');
    expect(drafts).toHaveLength(0);
  });

  it('skips a candidate with no matching RankingInput rather than fabricating one', () => {
    const candidates = [ranked('NODATA', 1, 'PROMOTE')];
    const drafts = buildTradePlanDrafts(candidates, new Map(), '2026-08-27');
    expect(drafts).toHaveLength(0);
  });

  it('derives BUY direction from positive momentum and SELL from negative momentum', () => {
    const buyCandidate = ranked('UP', 1, 'PROMOTE');
    const sellCandidate = ranked('DOWN', 2, 'PROMOTE');
    const inputs = new Map([
      ['UP', input('UP', { rawMomentumPct: 5 })],
      ['DOWN', input('DOWN', { rawMomentumPct: -5, last: 90, prevClose: 95, minuteHigh: 96, minuteLow: 89 })],
    ]);
    const drafts = buildTradePlanDrafts([buyCandidate, sellCandidate], inputs, '2026-08-27');
    expect(drafts.find((d) => d.symbol === 'UP')!.direction).toBe('BUY');
    expect(drafts.find((d) => d.symbol === 'DOWN')!.direction).toBe('SELL');
  });

  it('derives the entry zone from the real minute bar range when available', () => {
    const candidates = [ranked('AAPL', 1, 'PROMOTE')];
    const inputs = new Map([['AAPL', input('AAPL', { minuteHigh: 151, minuteLow: 149 })]]);
    const drafts = buildTradePlanDrafts(candidates, inputs, '2026-08-27');
    expect(drafts[0].entryZoneLow).toBe(149);
    expect(drafts[0].entryZoneHigh).toBe(151);
  });

  it('falls back to a documented +/-0.5% band when no minute bar range is available - never fabricates volatility', () => {
    const candidates = [ranked('NOBAR', 1, 'PROMOTE')];
    const inputs = new Map([['NOBAR', input('NOBAR', { minuteHigh: null, minuteLow: null, last: 100 })]]);
    const drafts = buildTradePlanDrafts(candidates, inputs, '2026-08-27');
    expect(drafts[0].entryZoneLow).toBeCloseTo(99.5, 5);
    expect(drafts[0].entryZoneHigh).toBeCloseTo(100.5, 5);
  });

  it('sets validUntil to 16:00 ET on the plan date', () => {
    const candidates = [ranked('AAPL', 1, 'PROMOTE')];
    const inputs = new Map([['AAPL', input('AAPL')]]);
    const drafts = buildTradePlanDrafts(candidates, inputs, '2026-08-27');
    expect(drafts[0].validUntil).toBe(new Date('2026-08-27T16:00:00-04:00').toISOString());
  });

  it('computes evidenceQuality as the real fraction of available components, not a fabricated number', () => {
    const candidates = [ranked('PARTIAL', 1, 'PROMOTE')];
    const inputs = new Map([['PARTIAL', input('PARTIAL')]]);
    const drafts = buildTradePlanDrafts(candidates, inputs, '2026-08-27');
    // fullComponents() has 5 available of 7 total (newsCatalyst/agentConfidence unavailable).
    expect(drafts[0].evidenceQuality).toBeCloseTo(5 / 7, 5);
  });

  it('respects custom thresholds', () => {
    const candidates = Array.from({ length: 5 }, (_, i) => ranked(`S${i}`, i + 1, 'PROMOTE'));
    const inputs = new Map(candidates.map((c) => [c.symbol, input(c.symbol)]));
    const drafts = buildTradePlanDrafts(candidates, inputs, '2026-08-27', new Date(), { primaryCount: 1, backupCount: 1, watchlistCount: 1 });
    const bySymbol = new Map(drafts.map((d) => [d.symbol, d]));
    expect(bySymbol.get('S0')!.setupType).toBe('PRIMARY');
    expect(bySymbol.get('S1')!.setupType).toBe('BACKUP');
    expect(bySymbol.get('S2')!.setupType).toBe('WATCHLIST');
    expect(bySymbol.has('S3')).toBe(false);
  });
});

describe('revalidateTradePlan', () => {
  const basePlan = { direction: 'BUY', invalidationLevel: 95, validUntil: new Date('2099-01-01').toISOString() };

  it('reports EXPIRED when validUntil has passed, regardless of current data', () => {
    const expiredPlan = { ...basePlan, validUntil: new Date('2000-01-01').toISOString() };
    const outcome = revalidateTradePlan(expiredPlan, input('AAPL'), ranked('AAPL', 1, 'PROMOTE'));
    expect(outcome.result).toBe('EXPIRED');
  });

  it('reports INVALIDATED (never silently VALID) when no current market data exists', () => {
    const outcome = revalidateTradePlan(basePlan, null, null);
    expect(outcome.result).toBe('INVALIDATED');
    expect(outcome.reason).toMatch(/no current market data/i);
  });

  it('reports INVALIDATED when a BUY plan price breaks below the invalidation level', () => {
    const outcome = revalidateTradePlan(basePlan, input('AAPL', { last: 90 }), ranked('AAPL', 1, 'PROMOTE'));
    expect(outcome.result).toBe('INVALIDATED');
    expect(outcome.reason).toMatch(/broke below/i);
  });

  it('reports INVALIDATED when a SELL plan price breaks above the invalidation level', () => {
    const sellPlan = { direction: 'SELL', invalidationLevel: 105, validUntil: new Date('2099-01-01').toISOString() };
    const outcome = revalidateTradePlan(sellPlan, input('AAPL', { last: 110 }), ranked('AAPL', 1, 'PROMOTE'));
    expect(outcome.result).toBe('INVALIDATED');
    expect(outcome.reason).toMatch(/broke above/i);
  });

  it('reports INVALIDATED when the current ranking cycle now recommends REJECT', () => {
    const outcome = revalidateTradePlan(basePlan, input('AAPL', { last: 100 }), ranked('AAPL', 50, 'REJECT', 0.1));
    expect(outcome.result).toBe('INVALIDATED');
    expect(outcome.reason).toMatch(/reject/i);
  });

  it('reports DOWNGRADED (not INVALIDATED) when the current cycle only recommends HOLD', () => {
    const outcome = revalidateTradePlan(basePlan, input('AAPL', { last: 100 }), ranked('AAPL', 20, 'HOLD', 0.4));
    expect(outcome.result).toBe('DOWNGRADED');
  });

  it('reports DOWNGRADED when the symbol no longer appears in the current ranking cycle at all', () => {
    const outcome = revalidateTradePlan(basePlan, input('AAPL', { last: 100 }), null);
    expect(outcome.result).toBe('DOWNGRADED');
    expect(outcome.reason).toMatch(/no longer appears/i);
  });

  it('reports REVALIDATED when price holds and the cycle still recommends PROMOTE', () => {
    const outcome = revalidateTradePlan(basePlan, input('AAPL', { last: 100 }), ranked('AAPL', 1, 'PROMOTE', 0.85));
    expect(outcome.result).toBe('REVALIDATED');
  });
});

describe('TradePlanBuilder persistence (DB-backed)', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `argus-tradeplan-${Date.now()}-${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
  });

  afterEach(() => {
    delete process.env.ARGUS_DB_PATH;
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* */ }
    }
  });

  it('persists drafts and reads them back via getTradePlansForDate', async () => {
    vi.resetModules();
    const { buildTradePlanDrafts: build, persistTradePlanDrafts, getTradePlansForDate } = await import('./TradePlanBuilder');
    const candidates = [ranked('AAPL', 1, 'PROMOTE')];
    const inputs = new Map([['AAPL', input('AAPL')]]);
    const drafts = build(candidates, inputs, '2026-08-27');

    await persistTradePlanDrafts(drafts);
    const rows = await getTradePlansForDate('2026-08-27');
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe('AAPL');
    expect(rows[0].status).toBe('READY');
  });

  it('persistRevalidation writes a history row and updates the plan status', async () => {
    vi.resetModules();
    const { buildTradePlanDrafts: build, persistTradePlanDrafts, persistRevalidation, getRevalidationHistory, getTradePlansForDate } = await import('./TradePlanBuilder');
    const candidates = [ranked('AAPL', 1, 'PROMOTE')];
    const inputs = new Map([['AAPL', input('AAPL')]]);
    const drafts = build(candidates, inputs, '2026-08-27');
    await persistTradePlanDrafts(drafts);

    await persistRevalidation(drafts[0].id, { result: 'INVALIDATED', reason: 'test invalidation', priceAtRevalidation: 90 });

    const history = await getRevalidationHistory(drafts[0].id);
    expect(history).toHaveLength(1);
    expect(history[0].result).toBe('INVALIDATED');

    const plans = await getTradePlansForDate('2026-08-27');
    expect(plans[0].status).toBe('INVALIDATED');
  });
});
