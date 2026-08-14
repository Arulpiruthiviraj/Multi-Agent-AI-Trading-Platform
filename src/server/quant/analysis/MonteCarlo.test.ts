import { describe, it, expect } from 'vitest';
import { runMonteCarlo } from './MonteCarlo';

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
