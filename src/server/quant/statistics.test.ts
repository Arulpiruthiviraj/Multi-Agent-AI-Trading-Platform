import { describe, it, expect } from 'vitest';
import {
  rollingMean, rollingStdDev, zScore, percentileRank, rollingReturns, rollingVolatility,
  correlation, covariance, beta, skewness, kurtosis, autocorrelation,
} from './statistics';

describe('statistics', () => {
  describe('rollingMean / rollingStdDev', () => {
    it('computes a known mean and population stddev', () => {
      const values = [2, 4, 4, 4, 5, 5, 7, 9];
      expect(rollingMean(values, 8)).toBe(5);
      expect(rollingStdDev(values, 8)).toBeCloseTo(2, 5);
    });

    it('returns null when there are fewer values than the requested period', () => {
      expect(rollingMean([1, 2], 5)).toBeNull();
      expect(rollingStdDev([1, 2], 5)).toBeNull();
    });
  });

  describe('zScore', () => {
    it('is 0 when the latest value equals the rolling mean (non-flat window)', () => {
      // mean of [10,20,30,40,25] is 25, and the last element is also 25 - a real 0 z-score,
      // distinct from the flat-window case below where stddev itself is 0.
      expect(zScore([10, 20, 30, 40, 25], 5)).toBe(0);
    });

    it('is positive when the latest value is above the mean', () => {
      const z = zScore([2, 4, 4, 4, 5, 5, 7, 9], 8);
      expect(z).not.toBeNull();
      expect(z as number).toBeGreaterThan(0);
    });

    it('returns null (not 0) for a perfectly flat window - stddev is 0, z-score is undefined', () => {
      expect(zScore([5, 5, 5, 5, 5], 5)).toBeNull();
      expect(zScore([3, 3, 3], 3)).toBeNull();
    });
  });

  describe('percentileRank', () => {
    it('ranks the current value against real history', () => {
      expect(percentileRank([1, 2, 3, 4, 5], 6)).toBe(100);
      expect(percentileRank([1, 2, 3, 4, 5], 0)).toBe(0);
      expect(percentileRank([1, 2, 3, 4, 5], 3)).toBe(40); // 1,2 are below 3
    });

    it('returns null for an empty history', () => {
      expect(percentileRank([], 5)).toBeNull();
    });
  });

  describe('rollingReturns', () => {
    it('computes simple period-over-period returns', () => {
      const returns = rollingReturns([100, 110, 99], 1);
      expect(returns[0]).toBeCloseTo(0.10, 5);
      expect(returns[1]).toBeCloseTo(-0.10, 5);
    });

    it('skips a zero anchor rather than emitting Infinity/NaN', () => {
      const returns = rollingReturns([0, 100], 1);
      expect(returns).toEqual([]);
    });
  });

  describe('correlation', () => {
    it('is +1 for a perfectly linearly related pair', () => {
      const a = Array.from({ length: 25 }, (_, i) => i);
      const b = Array.from({ length: 25 }, (_, i) => i * 2 + 3);
      expect(correlation(a, b)).toBeCloseTo(1, 8);
    });

    it('is -1 for a perfectly inversely related pair', () => {
      const a = Array.from({ length: 25 }, (_, i) => i);
      const b = Array.from({ length: 25 }, (_, i) => -i);
      expect(correlation(a, b)).toBeCloseTo(-1, 8);
    });

    it('is null below the minimum overlap', () => {
      expect(correlation([1, 2, 3], [1, 2, 3], 20)).toBeNull();
    });

    it('is null when one series has zero variance', () => {
      const flat = Array.from({ length: 25 }, () => 5);
      const varying = Array.from({ length: 25 }, (_, i) => i);
      expect(correlation(flat, varying)).toBeNull();
    });
  });

  describe('covariance', () => {
    it('is positive for series that move together', () => {
      const a = Array.from({ length: 25 }, (_, i) => i);
      const b = Array.from({ length: 25 }, (_, i) => i * 2);
      expect(covariance(a, b)).not.toBeNull();
      expect(covariance(a, b) as number).toBeGreaterThan(0);
    });
  });

  describe('beta', () => {
    it('is ~2 when the asset moves exactly 2x the benchmark', () => {
      const bench = Array.from({ length: 25 }, (_, i) => Math.sin(i) * 0.01);
      const asset = bench.map(r => r * 2);
      expect(beta(asset, bench)).toBeCloseTo(2, 5);
    });

    it('is null when the benchmark has zero variance', () => {
      const bench = Array.from({ length: 25 }, () => 0.01);
      const asset = Array.from({ length: 25 }, (_, i) => i * 0.001);
      expect(beta(asset, bench)).toBeNull();
    });
  });

  describe('skewness / kurtosis', () => {
    it('returns null below the minimum sample size', () => {
      expect(skewness([1, 2, 3])).toBeNull();
      expect(kurtosis([1, 2, 3])).toBeNull();
    });

    it('is exactly 0 for a genuinely symmetric series (each value in {-2..2} appears equally often)', () => {
      const symmetric = [-2, -1, 0, 1, 2, -2, -1, 0, 1, 2, -2, -1, 0, 1, 2, -2, -1, 0, 1, 2];
      expect(skewness(symmetric) as number).toBeCloseTo(0, 8);
    });

    it('is positive for a right-skewed series (rare large positive outliers)', () => {
      const rightSkewed = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 50];
      expect(skewness(rightSkewed) as number).toBeGreaterThan(0);
    });
  });

  describe('autocorrelation', () => {
    it('is high for a strongly trending (persistent) series', () => {
      const trending = Array.from({ length: 30 }, (_, i) => i);
      const ac = autocorrelation(trending, 1);
      expect(ac).not.toBeNull();
      expect(ac as number).toBeGreaterThan(0.9);
    });

    it('returns null when lag leaves too little overlap', () => {
      expect(autocorrelation([1, 2, 3, 4, 5], 4, 20)).toBeNull();
    });
  });

  describe('rollingVolatility', () => {
    it('returns null with insufficient history', () => {
      expect(rollingVolatility([1, 2], 20)).toBeNull();
    });

    it('is 0 for a perfectly steady percentage-return series', () => {
      const prices = [100];
      for (let i = 0; i < 25; i++) prices.push(prices[prices.length - 1] * 1.01);
      expect(rollingVolatility(prices, 20)).toBeCloseTo(0, 5);
    });
  });
});
