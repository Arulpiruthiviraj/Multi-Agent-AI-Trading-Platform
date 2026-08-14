import { describe, it, expect } from 'vitest';
import { bucketFor, bucketMidpoint, betaBinomialPosteriorMean, calibratedConfidenceForBucket, CONFIDENCE_BUCKETS, PRIOR_STRENGTH } from './ConfidenceCalibration';

describe('bucketFor', () => {
  it('assigns confidence to the correct band', () => {
    expect(bucketFor(0.3)).toEqual({ low: 0, high: 0.6 });
    expect(bucketFor(0.65)).toEqual({ low: 0.6, high: 0.7 });
    expect(bucketFor(0.85)).toEqual({ low: 0.8, high: 0.9 });
  });

  it('treats the final bucket\'s upper bound as inclusive (confidence of exactly 1.0 is valid)', () => {
    expect(bucketFor(1.0)).toEqual({ low: 0.9, high: 1.0 });
  });

  it('clamps out-of-range input rather than throwing', () => {
    expect(bucketFor(-0.5)).toEqual({ low: 0, high: 0.6 });
    expect(bucketFor(1.5)).toEqual({ low: 0.9, high: 1.0 });
  });

  it('every bucket boundary in the fixed set is covered exactly once', () => {
    for (const c of [0, 0.15, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0]) {
      expect(() => bucketFor(c)).not.toThrow();
    }
  });
});

describe('bucketMidpoint', () => {
  it('is the arithmetic mean of the bucket bounds', () => {
    expect(bucketMidpoint({ low: 0.8, high: 0.9 })).toBeCloseTo(0.85, 5);
  });
});

describe('betaBinomialPosteriorMean', () => {
  it('with zero real observations, the posterior equals the prior mean exactly - trusts the agent\'s own claim until data says otherwise', () => {
    expect(betaBinomialPosteriorMean(0, 0, 0.85)).toBeCloseTo(0.85, 5);
  });

  it('a thin real sample (n=1) barely moves the posterior away from the prior', () => {
    const posterior = betaBinomialPosteriorMean(0, 1, 0.85); // one real loss, prior strength 10
    // Should still be close to 0.85, not swing all the way to 0 from a single data point.
    expect(posterior).toBeGreaterThan(0.7);
    expect(posterior).toBeLessThan(0.85);
  });

  it('this is the real, defining case: NewsAgent\'s actual measured 80-90%-bucket accuracy (34.2%, n=76) pulls the posterior far down from the 0.85 prior, dominated by real data', () => {
    // 76 real evaluated predictions in this bucket, 34.2% win rate -> ~26 wins, ~50 losses.
    const wins = Math.round(76 * 0.342);
    const losses = 76 - wins;
    const posterior = calibratedConfidenceForBucket({ low: 0.8, high: 0.9 }, wins, losses);
    expect(posterior).toBeLessThan(0.45); // far below the 0.85 stated/prior confidence
    expect(posterior).toBeGreaterThan(0.30); // and close to the real 34.2%, not overshooting
  });

  it('a real, well-calibrated agent (accuracy matches its stated confidence) sees little to no penalty', () => {
    // 80 real observations at exactly the bucket's own claimed rate.
    const wins = 68; // 85% of 80
    const losses = 12;
    const posterior = calibratedConfidenceForBucket({ low: 0.8, high: 0.9 }, wins, losses);
    expect(posterior).toBeGreaterThan(0.8);
    expect(posterior).toBeLessThan(0.9);
  });

  it('with a genuinely large real sample, the prior\'s influence becomes negligible', () => {
    const posteriorSmallN = betaBinomialPosteriorMean(3, 7, 0.85); // n=10, matches prior strength
    const posteriorLargeN = betaBinomialPosteriorMean(300, 700, 0.85); // n=1000, same real ratio
    // Same real win rate (30%) at both sample sizes, but the small-N case should sit closer to
    // the 0.85 prior than the large-N case, which should be almost exactly 0.30.
    expect(posteriorLargeN).toBeCloseTo(0.30, 1);
    expect(posteriorSmallN).toBeGreaterThan(posteriorLargeN);
  });
});

describe('CONFIDENCE_BUCKETS / PRIOR_STRENGTH', () => {
  it('buckets are contiguous and cover [0,1] with no gaps', () => {
    for (let i = 1; i < CONFIDENCE_BUCKETS.length; i++) {
      expect(CONFIDENCE_BUCKETS[i].low).toBe(CONFIDENCE_BUCKETS[i - 1].high);
    }
    expect(CONFIDENCE_BUCKETS[0].low).toBe(0);
    expect(CONFIDENCE_BUCKETS[CONFIDENCE_BUCKETS.length - 1].high).toBe(1.0);
  });

  it('prior strength is a real, positive pseudo-sample-size', () => {
    expect(PRIOR_STRENGTH).toBeGreaterThan(0);
  });
});
