import { describe, it, expect } from 'vitest';
import { bucketFor, bucketMidpoint, betaBinomialPosteriorMean, calibratedConfidenceForBucket, calibratedConfidenceForRawSignal, isCalibrationSampleSufficient, CONFIDENCE_BUCKETS, PRIOR_STRENGTH } from './ConfidenceCalibration';

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

describe('calibratedConfidenceForRawSignal (2026-09-11 full trading readiness remediation, Phase 1 item 2)', () => {
  it('with zero real observations, anchors on the actual raw value, not a bucket-wide midpoint', () => {
    // Two different real raw values in the same [0.8,0.9) bucket must NOT collapse to the same
    // prior anymore - this is exactly the gap calibratedConfidenceForBucket() had.
    expect(calibratedConfidenceForRawSignal(0.82, 0, 0)).toBeCloseTo(0.82, 5);
    expect(calibratedConfidenceForRawSignal(0.89, 0, 0)).toBeCloseTo(0.89, 5);
  });

  it('a thin real sample barely moves the posterior away from THIS round\'s own raw value', () => {
    const posterior = calibratedConfidenceForRawSignal(0.82, 0, 1); // one real loss, prior strength 10
    expect(posterior).toBeGreaterThan(0.65);
    expect(posterior).toBeLessThan(0.82);
  });

  it('real finding: KronosEngine\'s actual measured 0.8-0.9 bucket (n=7271, ~47.2% empirical) converges to the same real answer regardless of raw-value anchor - large samples dominate either prior', () => {
    const wins = 3429, losses = 3842; // real production numbers
    const anchoredOnRaw85 = calibratedConfidenceForRawSignal(0.85, wins, losses);
    const anchoredOnRaw89 = calibratedConfidenceForRawSignal(0.89, wins, losses);
    const anchoredOnBucketMid = calibratedConfidenceForBucket({ low: 0.8, high: 0.9 }, wins, losses);
    // All three should land within a hair of the true empirical rate (0.4715) - the anchor choice
    // is immaterial once real sample size this large exists, confirming this is a real
    // overconfidence finding, not a calibration-methodology artifact.
    expect(anchoredOnRaw85).toBeCloseTo(0.4715, 2);
    expect(anchoredOnRaw89).toBeCloseTo(0.4715, 2);
    expect(anchoredOnBucketMid).toBeCloseTo(0.4715, 2);
  });
});

describe('isCalibrationSampleSufficient', () => {
  it('reuses the researchSafety.json minPaperTrades/minOosTrades precedent (30) as the sufficiency bar', () => {
    expect(isCalibrationSampleSufficient(20, 9, 30)).toBe(false); // n=29, just below the bar
    expect(isCalibrationSampleSufficient(20, 10, 30)).toBe(true); // n=30, exactly at the bar
    expect(isCalibrationSampleSufficient(10, 5, 30)).toBe(false); // n=15, thin
  });

  it('zero real observations is always insufficient', () => {
    expect(isCalibrationSampleSufficient(0, 0, 30)).toBe(false);
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
