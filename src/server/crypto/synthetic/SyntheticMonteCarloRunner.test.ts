import { describe, it, expect } from 'vitest';
import { runSingleSeed, runMonteCarlo } from './SyntheticMonteCarloRunner';

describe('runSingleSeed', () => {
  it('is deterministic given the same seed', () => {
    const a = runSingleSeed(7, 50, 500);
    const b = runSingleSeed(7, 50, 500);
    expect(a).toEqual(b);
  });

  it('different seeds produce different BTC total returns', () => {
    const a = runSingleSeed(1, 50, 500);
    const b = runSingleSeed(2, 50, 500);
    expect(a.btcTotalReturn).not.toBe(b.btcTotalReturn);
  });

  it('regime counts sum to totalBars', () => {
    const result = runSingleSeed(3, 20, 300);
    const sum = Object.values(result.regimeCounts).reduce((s, v) => s + v, 0);
    expect(sum).toBe(300);
  });
});

describe('runMonteCarlo', () => {
  it('runs one MonteCarloRunResult per seed', () => {
    const seeds = [1, 2, 3, 4, 5];
    const summary = runMonteCarlo(seeds, 20, 300);
    expect(summary.runs).toHaveLength(5);
    expect(summary.seedCount).toBe(5);
  });

  it('median/p25/p75/best/worst are internally consistent (worst <= p25 <= median <= p75 <= best)', () => {
    const seeds = Array.from({ length: 21 }, (_, i) => i + 1);
    const summary = runMonteCarlo(seeds, 20, 300);
    const { worst, p25, median, p75, best } = summary.btcTotalReturn;
    expect(worst).toBeLessThanOrEqual(p25);
    expect(p25).toBeLessThanOrEqual(median);
    expect(median).toBeLessThanOrEqual(p75);
    expect(p75).toBeLessThanOrEqual(best);
  });

  it('is fully deterministic across repeated runs with the same seed list', () => {
    const seeds = [10, 20, 30];
    const a = runMonteCarlo(seeds, 20, 200);
    const b = runMonteCarlo(seeds, 20, 200);
    expect(a).toEqual(b);
  });
});
