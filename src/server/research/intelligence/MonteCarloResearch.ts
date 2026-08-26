/**
 * Monte Carlo Simulation (Phase 12). Genuinely new — no Monte Carlo engine existed anywhere in
 * the codebase. Uses ONLY the supplied historical trade returns (randomized re-ordering /
 * bootstrap resampling with replacement) — never invents a return distribution, never assumes a
 * parametric model (no fabricated normal/lognormal assumption). Requires researchSafety.minOosTrades
 * real trades before running, same floor the rest of the research layer already uses.
 */
import { researchSafety } from '../../config/researchSafety';
import { wrapResearchResult, ResearchResult, DataQualityMeta } from './types';
import { emitResearchEvent } from './researchEventLog';
import { analyzeDrawdown } from './DrawdownResearch';

export interface MonteCarloRun {
  finalEquity: number;
  maxDrawdownPct: number;
  path: number[];
}

export interface MonteCarloResult {
  iterations: number;
  startingEquity: number;
  historicalTradeCount: number;
  distinguishFromHistorical: 'MONTE_CARLO_ESTIMATE'; // never presented as an actual trading result
  returnPercentiles: Record<'p5' | 'p25' | 'p50' | 'p75' | 'p95', number>;
  drawdownPercentiles: Record<'p5' | 'p25' | 'p50' | 'p75' | 'p95', number>;
  probabilityOfLoss: number;
  probabilityOfRuin: number;
  worstCaseFinalEquity: number;
  bestCaseFinalEquity: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * Bootstrap resampling (with replacement) of real historical per-trade returns — the standard,
 * non-parametric Monte Carlo method for trade sequences. `ruinThresholdPct` (e.g. 0.5 = equity
 * falls to 50% of starting) marks "ruin"; default matches researchSafety's drawdown floor context.
 */
export function runMonteCarloSimulation(opts: {
  historicalTradeReturnsPct: number[]; // e.g. [0.012, -0.008, 0.021, ...] per closed trade
  startingEquity?: number;
  iterations?: number;
  ruinThresholdPct?: number;
  seed?: () => number; // injectable RNG for deterministic tests — defaults to Math.random
}): MonteCarloResult | { insufficientSample: true; sampleSize: number; required: number } {
  const n = opts.historicalTradeReturnsPct.length;
  if (n < researchSafety.minOosTrades) {
    return { insufficientSample: true, sampleSize: n, required: researchSafety.minOosTrades };
  }
  const startingEquity = opts.startingEquity ?? 100000;
  const iterations = Math.max(100, Math.min(opts.iterations ?? 2000, 20000));
  const ruinThresholdPct = opts.ruinThresholdPct ?? 0.5;
  const rand = opts.seed ?? Math.random;

  const finals: number[] = [];
  const maxDds: number[] = [];
  let ruinCount = 0;
  let lossCount = 0;

  for (let i = 0; i < iterations; i++) {
    let equity = startingEquity;
    const series: Array<{ timestamp: number; equity: number }> = [{ timestamp: 0, equity }];
    for (let t = 0; t < n; t++) {
      const draw = opts.historicalTradeReturnsPct[Math.floor(rand() * n)];
      equity *= 1 + draw;
      series.push({ timestamp: t + 1, equity });
    }
    const dd = analyzeDrawdown(series);
    finals.push(equity);
    maxDds.push(dd.maxDrawdownPct);
    if (equity < startingEquity) lossCount++;
    if (equity <= startingEquity * ruinThresholdPct) ruinCount++;
  }

  const sortedFinals = [...finals].sort((a, b) => a - b);
  const sortedDds = [...maxDds].sort((a, b) => a - b);

  return {
    iterations,
    startingEquity,
    historicalTradeCount: n,
    distinguishFromHistorical: 'MONTE_CARLO_ESTIMATE',
    returnPercentiles: {
      p5: percentile(sortedFinals, 0.05),
      p25: percentile(sortedFinals, 0.25),
      p50: percentile(sortedFinals, 0.5),
      p75: percentile(sortedFinals, 0.75),
      p95: percentile(sortedFinals, 0.95),
    },
    drawdownPercentiles: {
      p5: percentile(sortedDds, 0.05),
      p25: percentile(sortedDds, 0.25),
      p50: percentile(sortedDds, 0.5),
      p75: percentile(sortedDds, 0.75),
      p95: percentile(sortedDds, 0.95),
    },
    probabilityOfLoss: lossCount / iterations,
    probabilityOfRuin: ruinCount / iterations,
    worstCaseFinalEquity: sortedFinals[0],
    bestCaseFinalEquity: sortedFinals[sortedFinals.length - 1],
  };
}

export function runMonteCarloResearch(opts: {
  symbol: string;
  strategyId: string;
  historicalTradeReturnsPct: number[];
  startingEquity?: number;
  iterations?: number;
  traceId?: string;
}): ResearchResult<ReturnType<typeof runMonteCarloSimulation>> {
  const data = runMonteCarloSimulation(opts);
  const insufficientSample = 'insufficientSample' in data && data.insufficientSample;
  const dataQuality: DataQualityMeta = {
    source: 'MonteCarloResearch.ts — bootstrap resampling of supplied historical trade returns (new; no prior Monte Carlo engine existed)',
    symbol: opts.symbol,
    timestamp: new Date().toISOString(),
    sampleSize: opts.historicalTradeReturnsPct.length,
    missingFields: insufficientSample ? [`fewer than ${researchSafety.minOosTrades} historical trades supplied`] : [],
    staleness: 'FRESH',
    assumptions: ['Bootstrap resampling with replacement of REAL historical trade returns only — no parametric/normal-distribution assumption', 'A Monte Carlo estimate is not a historical result and must never be presented as one'],
    quality: insufficientSample ? 'UNAVAILABLE' : 'GREEN',
  };
  const result = wrapResearchResult({ capability: 'MONTE_CARLO_SIMULATION', label: 'RESEARCH', dataQuality, data });
  emitResearchEvent('MONTE_CARLO_COMPLETED', {
    researchRunId: result.researchRunId,
    traceId: opts.traceId,
    symbol: opts.symbol,
    strategyId: opts.strategyId,
    insufficientSample,
  });
  return result;
}
