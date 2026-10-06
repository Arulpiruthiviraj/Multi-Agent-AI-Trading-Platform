/**
 * Unit tests for the pre-market opportunity score (workstream D).
 * Expected values are derived from config/premarketFocus.json (the same file
 * production loads) — never hardcoded duplicates of the weights.
 */
import { describe, it, expect } from 'vitest';
import { scorePremarketCandidate, type PremarketCandidateInput } from './PremarketOpportunityScore';
import { premarketFocusConfig } from '../config/premarketFocus';

const W = premarketFocusConfig.weights;
const S = premarketFocusConfig.scales;

function fullInput(): PremarketCandidateInput {
  return {
    symbol: 'AAA',
    overnightGapPct: 2.5,
    preMarketPctChange: -1.0,
    catalyst: { sentiment: 1, confidence: 0.8, recencyMinutes: 60, source: 'test', impactMagnitude: 0.7 },
    dollarVolume: 25_000_000,
    advShares: 4_000_000,
    spreadBps: 10,
    sectorRelativeStrength: 0.6,
    marketRelativeStrength: 0.9,
    strategyApplicability: ['MOMENTUM_BREAKOUT', 'PULLBACK_CONTINUATION'],
    dataFresh: true,
  };
}

describe('scorePremarketCandidate — per-component decomposition', () => {
  it('scores every component observably from config-derived expectations', () => {
    const b = scorePremarketCandidate(fullInput());
    const c = b.components;

    // Each component derived from the same config production loads.
    expect(c.overnightGap).toBeCloseTo(2.5 / S.gapScaleCapPct, 10);
    expect(c.preMarketPctChange).toBeCloseTo(1.0 / S.preMarketScaleCapPct, 10); // magnitude: |-1%|
    expect(c.catalystPresence).toBe(1);
    expect(c.catalystRecency).toBeCloseTo(1 - 60 / S.catalystRecencyZeroAtMinutes, 10);
    expect(c.signedSentiment).toBeCloseTo(1 * 0.8, 10);
    expect(c.liquidity).toBe(1); // max(25M/50M, 4M/2M) = 1
    expect(c.spreadQuality).toBeCloseTo(1 - 10 / S.spreadZeroAtBps, 10);
    expect(c.sectorRelativeStrength).toBe(0.6);
    expect(c.marketRelativeStrength).toBe(0.9);
    expect(c.strategyApplicability).toBeCloseTo(2 / S.strategyFullCount, 10);

    // Total is the weighted sum — recomputed here from the config weights.
    const expected =
      W.overnightGap * c.overnightGap +
      W.preMarketPctChange * c.preMarketPctChange +
      W.catalystPresence * c.catalystPresence +
      W.catalystRecency * c.catalystRecency +
      W.signedSentiment * c.signedSentiment +
      W.liquidity * c.liquidity +
      W.spreadQuality * c.spreadQuality +
      W.sectorRelativeStrength * c.sectorRelativeStrength +
      W.marketRelativeStrength * c.marketRelativeStrength +
      W.strategyApplicability * c.strategyApplicability;
    expect(b.total).toBeCloseTo(expected, 10);
    expect(b.total).toBeGreaterThan(0);
    expect(b.total).toBeLessThanOrEqual(1);

    // The returned weights are the config weights (same source of truth).
    expect(b.weights).toEqual(W);
    expect(b.symbol).toBe('AAA');
    expect(typeof b.scoredAt).toBe('string');
    expect(b.inputsMissing).toEqual([]);
    expect(b.inputsAvailable).toContain('overnightGapPct');
    expect(b.inputsAvailable).toContain('catalyst');
  });

  it('scores gap and pre-market move on magnitude (direction-blind)', () => {
    const up = scorePremarketCandidate({ ...fullInput(), overnightGapPct: 3, preMarketPctChange: 2 });
    const down = scorePremarketCandidate({ ...fullInput(), overnightGapPct: -3, preMarketPctChange: -2 });
    expect(up.components.overnightGap).toBe(down.components.overnightGap);
    expect(up.components.preMarketPctChange).toBe(down.components.preMarketPctChange);
    expect(up.total).toBe(down.total);
  });

  it('saturates every component at its cap; total is exactly the weight sum (1.0)', () => {
    const b = scorePremarketCandidate({
      symbol: 'MAX',
      overnightGapPct: 50,
      preMarketPctChange: -50,
      catalyst: { sentiment: 1, confidence: 1, recencyMinutes: 0, source: 't', impactMagnitude: 1 },
      dollarVolume: 1e12,
      spreadBps: 0,
      sectorRelativeStrength: 5,
      marketRelativeStrength: 5,
      strategyApplicability: ['a', 'b', 'c', 'd'],
      dataFresh: true,
    });
    for (const [k, v] of Object.entries(b.components)) {
      if (k === 'signedSentiment') {
        expect(v).toBe(1);
      } else {
        expect(v).toBe(1);
      }
    }
    expect(b.total).toBeCloseTo(1, 9);
  });
});

describe('scorePremarketCandidate — missing-input honesty', () => {
  it('scores 0 for every absent component and lists each missing input', () => {
    const b = scorePremarketCandidate({ symbol: 'EMPTY', dataFresh: false });
    expect(Object.values(b.components)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(b.total).toBe(0);
    for (const name of [
      'overnightGapPct',
      'preMarketPctChange',
      'catalyst',
      'dollarVolume',
      'advShares',
      'spreadBps',
      'sectorRelativeStrength',
      'marketRelativeStrength',
      'strategyApplicability',
    ]) {
      expect(b.inputsMissing).toContain(name);
    }
    // dataFresh is a required boolean — always present, never "missing".
    expect(b.inputsAvailable).toEqual(['dataFresh']);
  });

  it('treats an explicitly empty strategy list as a real 0 (available), not missing', () => {
    const b = scorePremarketCandidate({ symbol: 'X', strategyApplicability: [], dataFresh: true });
    expect(b.components.strategyApplicability).toBe(0);
    expect(b.inputsAvailable).toContain('strategyApplicability');
    expect(b.inputsMissing).not.toContain('strategyApplicability');
  });

  it('never fabricates: NaN / Infinity inputs are treated as missing', () => {
    const b = scorePremarketCandidate({
      symbol: 'X',
      overnightGapPct: NaN,
      dollarVolume: Infinity,
      sectorRelativeStrength: NaN,
      dataFresh: true,
    });
    expect(b.components.overnightGap).toBe(0);
    expect(b.components.liquidity).toBe(0);
    expect(b.components.sectorRelativeStrength).toBe(0);
    expect(b.inputsMissing).toContain('overnightGapPct');
    expect(b.inputsMissing).toContain('dollarVolume');
    expect(b.inputsMissing).toContain('sectorRelativeStrength');
  });
});

describe('scorePremarketCandidate — spread fail-open semantics', () => {
  it('null spread (explicitly unknown) is fail-open: neutral 1.0, not missing', () => {
    const b = scorePremarketCandidate({ symbol: 'X', spreadBps: null, dataFresh: true });
    expect(b.components.spreadQuality).toBe(1);
    expect(b.inputsAvailable).toContain('spreadBps');
    expect(b.inputsMissing).not.toContain('spreadBps');
  });

  it('undefined spread (not supplied) scores 0 and is listed missing', () => {
    const b = scorePremarketCandidate({ symbol: 'X', dataFresh: true });
    expect(b.components.spreadQuality).toBe(0);
    expect(b.inputsMissing).toContain('spreadBps');
  });

  it('wide spreads degrade quality linearly to 0 at the config cap', () => {
    const tight = scorePremarketCandidate({ symbol: 'X', spreadBps: 0, dataFresh: true });
    const wide = scorePremarketCandidate({ symbol: 'X', spreadBps: S.spreadZeroAtBps * 2, dataFresh: true });
    expect(tight.components.spreadQuality).toBe(1);
    expect(wide.components.spreadQuality).toBe(0);
  });
});

describe('scorePremarketCandidate — sentiment is contextual, never directional', () => {
  function sentimentOnlyInput(sentiment: -1 | 0 | 1): PremarketCandidateInput {
    return {
      symbol: 'S',
      // A catalyst must exist for sentiment to be scored; recency is forced to
      // 0 (ancient) so the ONLY nonzero catalyst contribution is sentiment.
      catalyst: { sentiment, confidence: 1, recencyMinutes: 10 ** 9, source: 't', impactMagnitude: 0 },
      spreadBps: null, // fail-open neutral, keeps the comparison clean
      dataFresh: true,
    };
  }

  it('extreme sentiment adjusts the total by exactly +/- its weight (documented ceiling)', () => {
    const pos = scorePremarketCandidate(sentimentOnlyInput(1));
    const neg = scorePremarketCandidate(sentimentOnlyInput(-1));
    const neu = scorePremarketCandidate(sentimentOnlyInput(0));

    expect(pos.components.signedSentiment).toBe(1);
    expect(neg.components.signedSentiment).toBe(-1);
    expect(neu.components.signedSentiment).toBe(0);

    // Sentiment's total influence is bounded and symmetric: flipping +1 to -1
    // moves the total by exactly 2x the weight — never more.
    expect(pos.total - neg.total).toBeCloseTo(2 * W.signedSentiment, 10);
    // The sentiment COMPONENT's own contribution never exceeds the documented
    // ceiling (it equals the weight because the component is bounded [-1,1]).
    expect(Math.abs(W.signedSentiment * pos.components.signedSentiment)).toBeLessThanOrEqual(
      premarketFocusConfig.sentimentAloneCeiling + 1e-12,
    );
    // Sentiment's marginal contribution over the neutral case is exactly one weight.
    expect(pos.total - neu.total).toBeCloseTo(W.signedSentiment, 10);
    // Negative sentiment dampens attention (contextual), it does not go
    // negative as a total: the total is clamped to [0,1].
    expect(neg.total).toBeGreaterThanOrEqual(0);
  });

  it('sentiment confidence scales the signed contribution', () => {
    const full = scorePremarketCandidate({
      symbol: 'X',
      catalyst: { sentiment: 1, confidence: 1, recencyMinutes: 10 ** 9, source: 't', impactMagnitude: 0 },
      spreadBps: null,
      dataFresh: true,
    });
    const half = scorePremarketCandidate({
      symbol: 'X',
      catalyst: { sentiment: 1, confidence: 0.5, recencyMinutes: 10 ** 9, source: 't', impactMagnitude: 0 },
      spreadBps: null,
      dataFresh: true,
    });
    expect(full.components.signedSentiment).toBeCloseTo(1, 10);
    expect(half.components.signedSentiment).toBeCloseTo(0.5, 10);
    expect(full.total - half.total).toBeCloseTo(0.5 * W.signedSentiment, 10);
  });

  it('the breakdown carries no direction/side — sentiment cannot become a trigger', () => {
    const b = scorePremarketCandidate(sentimentOnlyInput(1));
    expect('direction' in b).toBe(false);
    expect('side' in b).toBe(false);
    expect('signal' in b).toBe(false);
    const serialized = JSON.stringify(b);
    expect(serialized).not.toContain('BUY');
    expect(serialized).not.toContain('SELL');
  });
});

describe('scorePremarketCandidate — config sanity', () => {
  it('weights sum to 1.0 (loader also enforces this)', () => {
    const sum = Object.values(W).reduce((a, v) => a + v, 0);
    expect(sum).toBeCloseTo(1, 9);
  });

  it('sentiment ceiling equals the sentiment weight', () => {
    expect(premarketFocusConfig.sentimentAloneCeiling).toBeCloseTo(W.signedSentiment, 12);
  });
});
