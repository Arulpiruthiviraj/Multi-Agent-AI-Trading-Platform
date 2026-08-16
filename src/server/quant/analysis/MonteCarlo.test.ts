import { describe, it, expect } from 'vitest';
import {
  runMonteCarlo,
  permutationTestSharpe,
  evaluateOosSharpeDegradation,
  evaluateOosWinRate,
  evaluateWalkForwardHarness,
  STATISTICALLY_INSIGNIFICANT,
  annualizedSharpe,
} from './MonteCarlo';
import { tradingSafety } from '../../config/tradingSafety';

describe('runMonteCarlo', () => {
  it('is deterministic for a fixed seed - real reproducibility, not Math.random() nondeterminism', () => {
    const rMultiples = [1, -1, 2, -1, 1.5, -0.5, 1, -1, 0.5, 2, -1, 1, -0.5, 1.5, -1, 1, 2, -1, 0.5, 1];
    const a = runMonteCarlo({ rMultiples, initialCapital: 100000, riskPerTradePct: 0.02 }, 7);
    const b = runMonteCarlo({ rMultiples, initialCapital: 100000, riskPerTradePct: 0.02 }, 7);
    expect(a).toEqual(b);
  });

  it('flags statisticallyJustified=false below the shared MIN_SAMPLE_SIZE_FOR_KELLY threshold, matching ExpectedValue.ts', () => {
    const result = runMonteCarlo({ rMultiples: [1, -1, 1], initialCapital: 100000, riskPerTradePct: 0.02 });
    expect(result.statisticallyJustified).toBe(false);
    expect(result.note).toContain('below the');
  });

  it('reports statisticallyJustified=true at or above the threshold', () => {
    const rMultiples = Array.from({ length: 25 }, (_, i) => (i % 2 === 0 ? 1.5 : -1));
    const result = runMonteCarlo({ rMultiples, initialCapital: 100000, riskPerTradePct: 0.02 });
    expect(result.statisticallyJustified).toBe(true);
    expect(result.note).toBeNull();
  });

  it('always labels output as scenarioAnalysis, never a prediction', () => {
    const result = runMonteCarlo({ rMultiples: [1, -1], initialCapital: 100000, riskPerTradePct: 0.02 });
    expect(result.scenarioAnalysis).toBe(true);
  });

  it('a strictly negative-expectancy real trade history produces a real median loss, not an invented positive result', () => {
    const rMultiples = Array.from({ length: 30 }, () => -1); // every real trade was a full loss
    const result = runMonteCarlo({ rMultiples, initialCapital: 100000, riskPerTradePct: 0.02, pathLength: 30, simulations: 500 }, 1);
    expect(result.endingEquity.p50).toBeLessThan(100000);
    expect(result.probabilityOfLoss).toBeGreaterThan(0.9);
  });

  it('a strictly positive-expectancy real trade history produces real median growth', () => {
    const rMultiples = Array.from({ length: 30 }, () => 1); // every real trade was a full win
    const result = runMonteCarlo({ rMultiples, initialCapital: 100000, riskPerTradePct: 0.02, pathLength: 30, simulations: 500 }, 1);
    expect(result.endingEquity.p50).toBeGreaterThan(100000);
    expect(result.probabilityOfLoss).toBe(0);
  });

  it('handles zero real trades honestly rather than dividing by zero or fabricating a curve', () => {
    const result = runMonteCarlo({ rMultiples: [], initialCapital: 100000, riskPerTradePct: 0.02 });
    expect(result.statisticallyJustified).toBe(false);
    expect(result.endingEquity.p50).toBe(100000);
    expect(result.note).toContain('No real closed trades');
  });

  it('equity never goes negative even under a punishing resampled loss streak', () => {
    const rMultiples = Array.from({ length: 25 }, () => -5); // catastrophic real losses
    const result = runMonteCarlo({ rMultiples, initialCapital: 1000, riskPerTradePct: 0.5, pathLength: 50, simulations: 200 }, 3);
    expect(result.endingEquity.p5).toBeGreaterThanOrEqual(0);
  });
});

describe('permutationTestSharpe', () => {
  it('flags a strong positive-mean series as SIGNIFICANT at the configured alpha', () => {
    const returns = Array.from({ length: 80 }, (_, i) => 0.004 + (i % 7) * 0.001);
    const r = permutationTestSharpe(returns, 500, tradingSafety.permutationSignificanceAlpha, 1);
    expect(r.observedSharpe).toBeGreaterThan(0);
    expect(r.pValue).toBeLessThanOrEqual(tradingSafety.permutationSignificanceAlpha);
    expect(r.verdict).toBe('SIGNIFICANT');
  });

  it(`flags a zero-mean series as ${STATISTICALLY_INSIGNIFICANT}`, () => {
    const returns = Array.from({ length: 80 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    const r = permutationTestSharpe(returns, 500, tradingSafety.permutationSignificanceAlpha, 1);
    expect(r.pValue).toBeGreaterThan(tradingSafety.permutationSignificanceAlpha);
    expect(r.verdict).toBe(STATISTICALLY_INSIGNIFICANT);
  });

  it('is deterministic for a fixed seed', () => {
    const returns = [0.01, -0.005, 0.008, -0.002, 0.012, -0.004];
    expect(permutationTestSharpe(returns, 200, 0.05, 9)).toEqual(permutationTestSharpe(returns, 200, 0.05, 9));
  });

  it('annualizedSharpe is 0 when volatility is 0', () => {
    expect(annualizedSharpe([0.01, 0.01, 0.01])).toBe(0);
  });
});

describe('walk-forward degradation enforcer', () => {
  it('OVERFIT_REJECTED when OOS Sharpe drops more than (1 - oosSharpeDegradationMinRatio)', () => {
    const is = 2;
    const oos = is * tradingSafety.oosSharpeDegradationMinRatio - 0.01;
    const r = evaluateWalkForwardHarness({
      periodCount: 6,
      avgSharpeIS: is,
      avgSharpeOOS: oos,
      avgOosWinRatePct: 90,
    });
    expect(evaluateOosSharpeDegradation(is, oos).rejected).toBe(true);
    expect(r.verdict).toBe('OVERFIT_REJECTED');
  });

  it('OVERFIT_REJECTED when OOS win rate is below tradingSafety.oosWinRateMinPct', () => {
    const r = evaluateWalkForwardHarness({
      periodCount: 6,
      avgSharpeIS: 1.5,
      avgSharpeOOS: 1.4,
      avgOosWinRatePct: tradingSafety.oosWinRateMinPct - 1,
    });
    expect(evaluateOosWinRate(tradingSafety.oosWinRateMinPct - 1).passed).toBe(false);
    expect(r.verdict).toBe('OVERFIT_REJECTED');
  });

  it('PASS when Sharpe ratio and OOS win rate both clear the configured floors', () => {
    const r = evaluateWalkForwardHarness({
      periodCount: 6,
      avgSharpeIS: 1.5,
      avgSharpeOOS: 1.2,
      avgOosWinRatePct: tradingSafety.oosWinRateMinPct + 10,
    });
    expect(r.verdict).toBe('PASS');
  });

  it('INSUFFICIENT_PERIODS when metrics pass but the window count is too small', () => {
    const r = evaluateWalkForwardHarness({
      periodCount: 2,
      avgSharpeIS: 1.5,
      avgSharpeOOS: 1.2,
      avgOosWinRatePct: 80,
    });
    expect(r.verdict).toBe('INSUFFICIENT_PERIODS');
  });
});
