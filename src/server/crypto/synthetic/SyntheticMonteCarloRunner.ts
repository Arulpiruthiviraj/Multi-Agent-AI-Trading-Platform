/**
 * ARGUS Crypto V2 - Monte Carlo / multi-seed runner (2026-09-21). Runs the population+price
 * generation pipeline across many seeds and reports the DISTRIBUTION of outcomes (median/p25/p75/
 * best/worst), not a single lucky universe (mandate section 32: "Do not rely on one lucky
 * synthetic universe"). Pure computation - no I/O; callers decide whether to persist results via
 * SyntheticExperimentRegistry.
 */
import { SyntheticRandom } from '../../replay/synthetic/SyntheticRandom';
import { generateSyntheticCryptoPopulation } from './SyntheticCryptoPopulationGenerator';
import { generateRegimePath } from './SyntheticCryptoRegimeStateMachine';
import { generateBtcFactorReturns, generateSyntheticCryptoPricePath } from './SyntheticCryptoPriceProcess';

export interface MonteCarloRunResult {
  seed: number;
  btcTotalReturn: number;
  assetCount: number;
  regimeCounts: Record<string, number>;
}

export interface MonteCarloSummary {
  seedCount: number;
  btcTotalReturn: { median: number; p25: number; p75: number; best: number; worst: number };
  runs: MonteCarloRunResult[];
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

/** Runs one full population+price generation for the given seed and returns real summary stats -
 *  never a fabricated or assumed outcome, always derived from that seed's own generated path. */
export function runSingleSeed(seed: number, populationSize: number, totalBars: number): MonteCarloRunResult {
  const population = generateSyntheticCryptoPopulation({ populationSeed: seed, populationSize }, totalBars);
  const regimeRng = new SyntheticRandom(seed * 2 + 1);
  const regimePath = generateRegimePath(regimeRng, totalBars, 'RANGE');
  const btcAsset = population[0];
  const btcFactorReturns = generateBtcFactorReturns(new SyntheticRandom(seed * 2 + 2), regimePath, btcAsset.baseVolatilityPerBar);
  const btcBars = generateSyntheticCryptoPricePath(btcAsset, regimePath, btcFactorReturns, new SyntheticRandom(seed * 2 + 3), 0, 60_000);

  const btcTotalReturn = btcBars.length > 1 ? (btcBars[btcBars.length - 1].close - btcBars[0].open) / btcBars[0].open : 0;

  const regimeCounts: Record<string, number> = {};
  for (const regime of regimePath) regimeCounts[regime] = (regimeCounts[regime] ?? 0) + 1;

  return { seed, btcTotalReturn, assetCount: population.length, regimeCounts };
}

export function runMonteCarlo(seeds: readonly number[], populationSize: number, totalBars: number): MonteCarloSummary {
  const runs = seeds.map((seed) => runSingleSeed(seed, populationSize, totalBars));
  const sortedReturns = runs.map((r) => r.btcTotalReturn).slice().sort((a, b) => a - b);
  return {
    seedCount: seeds.length,
    btcTotalReturn: {
      median: percentile(sortedReturns, 0.5),
      p25: percentile(sortedReturns, 0.25),
      p75: percentile(sortedReturns, 0.75),
      best: sortedReturns[sortedReturns.length - 1],
      worst: sortedReturns[0],
    },
    runs,
  };
}
