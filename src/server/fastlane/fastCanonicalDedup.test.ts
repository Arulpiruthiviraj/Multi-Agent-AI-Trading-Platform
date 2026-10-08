import { describe, it, expect, afterEach } from 'vitest';
import {
  processFastEvaluationForCanonicalIdea,
  resetFastCanonicalDedupForTests,
  fastCanonicalDedupCacheSizeForTests,
  classifyEvidenceCollision,
} from './fastCanonicalDedup';
import type { FastEvaluationResult, FastOpportunityCandidate } from './FastOpportunityCandidate';

function fakeCandidate(overrides: Partial<FastOpportunityCandidate> = {}): FastOpportunityCandidate {
  const now = Date.now();
  return {
    id: 'cand-1',
    symbol: 'AAPL',
    detectedAt: now,
    expiresAt: now + 60 * 60_000,
    lastEvidenceAt: now,
    detectionSource: 'NEWS_CATALYST',
    liquidityEvidence: { dollarVolume: null, spreadBps: null, meetsMinLiquidity: false },
    requiredDataTier: 'TIER_1',
    currentDataTier: 'TIER_0',
    applicableStrategies: [],
    state: 'ACTIONABLE',
    stateHistory: [],
    ...overrides,
  };
}

function fakeResult(overrides: Partial<FastEvaluationResult> = {}): FastEvaluationResult {
  const now = Date.now();
  return {
    id: 'cand-1:123',
    candidateId: 'cand-1',
    symbol: 'AAPL',
    evaluatedAt: now,
    dataAsOf: now,
    marketDataType: 'CACHED_BARS',
    strategiesEvaluated: ['MOMENTUM_BREAKOUT'],
    validTriggers: ['MOMENTUM_BREAKOUT'],
    bestStrategy: 'MOMENTUM_BREAKOUT',
    direction: 'BUY',
    confidence: 0.82,
    status: 'VALID_STRATEGY_EVIDENCE',
    reasonCodes: ['TRIGGER_MET_CONFIDENCE_QUALIFIED'],
    dataSufficiency: { bars: 'AVAILABLE' },
    ...overrides,
  };
}

afterEach(() => {
  resetFastCanonicalDedupForTests();
});

describe('processFastEvaluationForCanonicalIdea - idempotency (Section 5)', () => {
  it('the SAME FastEvaluationResult delivered 10 times produces exactly ONE canonical idea', () => {
    const candidate = fakeCandidate();
    const result = fakeResult();
    const outcomes = Array.from({ length: 10 }, () => processFastEvaluationForCanonicalIdea(result, candidate));
    for (const o of outcomes) expect(o.ok).toBe(true);
    const ideaIds = outcomes.map((o) => (o.ok ? o.idea.evidence.fastEvaluationId : null));
    expect(new Set(ideaIds).size).toBe(1); // all ten resolved to the identical cached idea
    expect(fastCanonicalDedupCacheSizeForTests()).toBe(1); // exactly one entry, not ten
    expect(outcomes.filter((o) => o.ok && !o.wasAlreadyCached)).toHaveLength(1); // created exactly once
    expect(outcomes.filter((o) => o.ok && o.wasAlreadyCached)).toHaveLength(9); // deduped the other nine
  });

  it('rejected evaluations (no trigger, insufficient data, etc.) never enter the cache', () => {
    const candidate = fakeCandidate();
    const outcome = processFastEvaluationForCanonicalIdea(fakeResult({ status: 'NO_VALID_SETUP', bestStrategy: undefined, direction: undefined, confidence: undefined, validTriggers: [] }), candidate);
    expect(outcome.ok).toBe(false);
    expect(fastCanonicalDedupCacheSizeForTests()).toBe(0);
  });

  it('genuinely different evidence (different symbol) produces a SEPARATE canonical idea, not deduped against an unrelated one', () => {
    const candidate = fakeCandidate();
    const first = processFastEvaluationForCanonicalIdea(fakeResult({ symbol: 'AAPL' }), candidate);
    const second = processFastEvaluationForCanonicalIdea(fakeResult({ symbol: 'MSFT', id: 'cand-2:123', candidateId: 'cand-2' }), fakeCandidate({ id: 'cand-2', symbol: 'MSFT' }));
    expect(first.ok && second.ok).toBe(true);
    expect(fastCanonicalDedupCacheSizeForTests()).toBe(2);
  });

  it('D5: the cache is bounded - oldest entries are evicted past fastLaneCanonicalIdeaCacheMaxEntries', async () => {
    const { tradingSafety } = await import('../config/tradingSafety');
    const originalMax = tradingSafety.fastLaneCanonicalIdeaCacheMaxEntries;
    (tradingSafety as any).fastLaneCanonicalIdeaCacheMaxEntries = 5;
    try {
      const candidate = fakeCandidate();
      // 8 genuinely different evaluations (different symbols => different fingerprints)
      for (let i = 0; i < 8; i++) {
        const sym = `SYM${i}`;
        const outcome = processFastEvaluationForCanonicalIdea(
          fakeResult({ symbol: sym, id: `cand-${i}:123`, candidateId: `cand-${i}` }),
          fakeCandidate({ id: `cand-${i}`, symbol: sym }),
        );
        expect(outcome.ok).toBe(true);
      }
      expect(fastCanonicalDedupCacheSizeForTests()).toBe(5); // bounded, not 8
    } finally {
      (tradingSafety as any).fastLaneCanonicalIdeaCacheMaxEntries = originalMax;
    }
  });
});

describe('classifyEvidenceCollision (Section 6, observational only)', () => {
  const momentumBuyAAPL = { strategy: 'MOMENTUM_BREAKOUT', symbol: 'AAPL', side: 'BUY' as const, dataAsOf: 1_700_000_000_000 };

  it('SAME_STRATEGY_SAME_EVIDENCE when strategy/symbol/side/data-as-of-minute all match', () => {
    const existing = { ...momentumBuyAAPL, dataAsOf: 1_700_000_000_000 + 5_000 }; // same minute bucket
    expect(classifyEvidenceCollision(momentumBuyAAPL, existing)).toBe('SAME_STRATEGY_SAME_EVIDENCE');
  });

  it('SAME_STRATEGY_NEWER_EVIDENCE when strategy/symbol/side match but data-as-of is a later bucket', () => {
    const existing = { ...momentumBuyAAPL, dataAsOf: momentumBuyAAPL.dataAsOf - 10 * 60_000 }; // 10 minutes earlier
    expect(classifyEvidenceCollision(momentumBuyAAPL, existing)).toBe('SAME_STRATEGY_NEWER_EVIDENCE');
  });

  it('DIFFERENT_STRATEGY_UNKNOWN_CORRELATION when the symbol matches but the strategy differs - honestly not claimed as correlated OR independent', () => {
    const existing = { ...momentumBuyAAPL, strategy: 'MEAN_REVERSION' };
    expect(classifyEvidenceCollision(momentumBuyAAPL, existing)).toBe('DIFFERENT_STRATEGY_UNKNOWN_CORRELATION');
  });

  it('GENUINELY_INDEPENDENT_EVIDENCE when there is no prior evidence for this symbol at all', () => {
    expect(classifyEvidenceCollision(momentumBuyAAPL, null)).toBe('GENUINELY_INDEPENDENT_EVIDENCE');
  });

  it('GENUINELY_INDEPENDENT_EVIDENCE when the symbol differs entirely', () => {
    const existing = { ...momentumBuyAAPL, symbol: 'MSFT' };
    expect(classifyEvidenceCollision(momentumBuyAAPL, existing)).toBe('GENUINELY_INDEPENDENT_EVIDENCE');
  });

  it('GENUINELY_INDEPENDENT_EVIDENCE when the same strategy/symbol disagree on side - a real disagreement, not a duplicate', () => {
    const existing = { ...momentumBuyAAPL, side: 'SELL' as const };
    expect(classifyEvidenceCollision(momentumBuyAAPL, existing)).toBe('GENUINELY_INDEPENDENT_EVIDENCE');
  });

  it('SAME_STRATEGY_SAME_EVIDENCE when both sides have null dataAsOf - unknown buckets match, not treated as distinct', () => {
    const incoming = { ...momentumBuyAAPL, dataAsOf: null };
    const existing = { ...momentumBuyAAPL, dataAsOf: null };
    expect(classifyEvidenceCollision(incoming, existing)).toBe('SAME_STRATEGY_SAME_EVIDENCE');
  });

  it('null vs real dataAsOf on the same strategy/symbol/side classifies as newer evidence, not identical', () => {
    const incoming = { ...momentumBuyAAPL, dataAsOf: 1_700_000_000_000 };
    const existing = { ...momentumBuyAAPL, dataAsOf: null };
    // fingerprints differ ('unknown' vs a real bucket), same side -> newer evidence
    expect(classifyEvidenceCollision(incoming, existing)).toBe('SAME_STRATEGY_NEWER_EVIDENCE');
  });
});
