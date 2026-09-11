/**
 * PBO (Probability of Backtest Overfitting) via CSCV (Combinatorially Symmetric Cross-Validation).
 *
 * Bailey, Borwein, Lopez de Prado, Zhu - "The Probability of Backtest Overfitting" (SSRN 2568435),
 * Algorithm 2.3 - read directly from the source paper, not a paraphrase; full reading notes with
 * real page citations at docs/audits/ARGUS_QUANT_LIBRARY_PBO_2026-09-11.md.
 *
 * Pure, read-only statistical audit over ALREADY-COMPUTED backtest return series (real backtest
 * output from quant_strategy_backtests, via scripts/compute_pbo.ts). Per the paper's own explicit
 * warning (p.25): "when a measure becomes a target, it ceases to be a good measure" - PBO must
 * never be used as a search/optimization objective, and this module is deliberately not imported
 * by any live-path file (ChiefTraderAgent, RiskEngine, OMS, or any gate `evaluateLiveReadiness()`
 * reads). It answers "was the backtest-selection process itself likely to have overfit?", not
 * "is this strategy profitable" - see the reading-notes doc's own §4 for what it does NOT prove.
 */
import { annualizedSharpe, mean } from '../quant/analysis/MonteCarlo';

export interface PboInput {
  /** One entry per strategy configuration (a column of the CSCV return matrix). */
  configurations: Array<{
    id: string;
    /** Period returns, already time-ordered. Different configurations may have different lengths -
     *  computePbo() truncates every column to the shortest one, so real calendar synchronization
     *  across configurations is the CALLER's responsibility, not verified here. */
    returns: number[];
  }>;
  /** Number of equal-size time slices (S). Must be even and >= 4. Paper's own practical default: 16
   *  (p.22 - keeps the PBO standard error below ~0.0045 for a typical multi-year daily series). */
  slices?: number;
}

export interface PboResult {
  pbo: number;
  combinationsEvaluated: number;
  slicesUsed: number;
  observationsPerConfiguration: number;
  observationsAvailable: number;
  numConfigurations: number;
  /** Slope of a simple linear regression of OOS-Sharpe(n*) on IS-Sharpe(n*) across all combinations
   *  (paper's "performance degradation", p.14-15). Null only when IS-Sharpe(n*) had zero variance
   *  across combinations (degenerate regression input). */
  performanceDegradationSlope: number | null;
  /** Fraction of combinations where the IS-selected configuration's OOS Sharpe was negative. */
  probabilityOfLoss: number;
  /** A simplified proxy for the paper's stochastic-dominance test (p.17-19) - compares the mean OOS
   *  Sharpe of the IS-selected configuration against the mean OOS Sharpe of a uniformly-random OTHER
   *  configuration, across the same combinations. This is NOT the paper's full first/second-order
   *  CDF-based dominance test (out of scope for this pass) - do not over-interpret as rigorous. */
  simplifiedStochasticDominance: {
    meanOosSharpeOfSelected: number;
    meanOosSharpeOfRandomAlternative: number;
    selectedDominates: boolean;
  };
  logits: number[];
  note: string;
}

export type PboComputation = PboResult | { error: string };

function combinationsOf<T>(items: T[], k: number): T[][] {
  const results: T[][] = [];
  const combo: T[] = [];
  function backtrack(start: number): void {
    if (combo.length === k) {
      results.push([...combo]);
      return;
    }
    for (let i = start; i < items.length; i++) {
      combo.push(items[i]);
      backtrack(i + 1);
      combo.pop();
    }
  }
  backtrack(0);
  return results;
}

/** 1-indexed ascending rank (1 = worst, N = best). Ties share the average rank - standard convention,
 *  matches the paper's own use of relative rank omega = rank/(N+1). */
function rankAscending(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(values.length).fill(0);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j++;
    const avgRank = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k++) ranks[indexed[k].i] = avgRank;
    i = j + 1;
  }
  return ranks;
}

export function computePbo(input: PboInput): PboComputation {
  const { configurations } = input;
  const slices = input.slices ?? 16;

  if (configurations.length < 2) {
    return { error: 'INSUFFICIENT_CONFIGURATIONS: PBO/CSCV requires at least 2 strategy configurations (columns) - not computed.' };
  }
  if (!Number.isInteger(slices) || slices < 4 || slices % 2 !== 0) {
    return { error: 'INVALID_SLICE_COUNT: slices must be an even integer >= 4 (paper default: 16) - not computed.' };
  }

  const observationsAvailable = Math.min(...configurations.map((c) => c.returns.length));
  const sliceSize = Math.floor(observationsAvailable / slices);
  if (sliceSize < 2) {
    return {
      error: `INSUFFICIENT_OBSERVATIONS: only ${observationsAvailable} synchronized observations available across `
        + `${configurations.length} configurations - need at least ${slices * 2} for ${slices} slices of >=2 each. Not computed.`,
    };
  }

  const N = configurations.length;
  const usedT = sliceSize * slices;
  // Truncate every configuration's return series to the same slice-aligned length. Drops the
  // trailing (most recent) usedT..observationsAvailable-1 observations, not the leading ones -
  // stated explicitly in the result's own `note` rather than left silent.
  const M = configurations.map((c) => c.returns.slice(0, usedT));

  const sliceRowIndices: number[][] = [];
  for (let s = 0; s < slices; s++) {
    const start = s * sliceSize;
    sliceRowIndices.push(Array.from({ length: sliceSize }, (_, k) => start + k));
  }

  const sliceIds = Array.from({ length: slices }, (_, s) => s);
  const trainCombos = combinationsOf(sliceIds, slices / 2);

  const logits: number[] = [];
  const isSharpesOfSelected: number[] = [];
  const oosSharpesOfSelected: number[] = [];
  const oosSharpesOfRandomAlternative: number[] = [];
  // Deterministic LCG, not crypto-random: this script's own reproducibility (same input -> same
  // output) matters more than true randomness for a single uniform "pick one other configuration"
  // draw per combination.
  let rngState = 0x2f6e2b1;

  for (const trainSet of trainCombos) {
    const trainSetIds = new Set(trainSet);
    const trainRows: number[] = [];
    const testRows: number[] = [];
    for (const s of sliceIds) {
      const bucket = trainSetIds.has(s) ? trainRows : testRows;
      bucket.push(...sliceRowIndices[s]);
    }

    const isSharpes = M.map((series) => annualizedSharpe(trainRows.map((r) => series[r])));
    const oosSharpes = M.map((series) => annualizedSharpe(testRows.map((r) => series[r])));

    let nStar = 0;
    for (let i = 1; i < N; i++) if (isSharpes[i] > isSharpes[nStar]) nStar = i;

    const oosRanks = rankAscending(oosSharpes);
    const omega = oosRanks[nStar] / (N + 1);
    const clampedOmega = Math.min(1 - 1e-9, Math.max(1e-9, omega));
    logits.push(Math.log(clampedOmega / (1 - clampedOmega)));

    isSharpesOfSelected.push(isSharpes[nStar]);
    oosSharpesOfSelected.push(oosSharpes[nStar]);

    rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
    if (N > 1) {
      let randIdx = rngState % (N - 1);
      if (randIdx >= nStar) randIdx += 1;
      oosSharpesOfRandomAlternative.push(oosSharpes[randIdx]);
    } else {
      oosSharpesOfRandomAlternative.push(oosSharpes[nStar]);
    }
  }

  const pbo = logits.filter((l) => l <= 0).length / logits.length;
  const probabilityOfLoss = oosSharpesOfSelected.filter((s) => s < 0).length / oosSharpesOfSelected.length;

  let performanceDegradationSlope: number | null = null;
  {
    const xs = isSharpesOfSelected;
    const ys = oosSharpesOfSelected;
    const mx = mean(xs);
    const my = mean(ys);
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      den += (xs[i] - mx) * (xs[i] - mx);
    }
    performanceDegradationSlope = den > 0 ? num / den : null;
  }

  const meanSelected = mean(oosSharpesOfSelected);
  const meanRandom = mean(oosSharpesOfRandomAlternative);

  return {
    pbo,
    combinationsEvaluated: trainCombos.length,
    slicesUsed: slices,
    observationsPerConfiguration: usedT,
    observationsAvailable,
    numConfigurations: N,
    performanceDegradationSlope,
    probabilityOfLoss,
    simplifiedStochasticDominance: {
      meanOosSharpeOfSelected: meanSelected,
      meanOosSharpeOfRandomAlternative: meanRandom,
      selectedDominates: meanSelected >= meanRandom,
    },
    logits,
    note: `Real CSCV per Bailey/Borwein/Lopez de Prado/Zhu Algorithm 2.3, S=${slices} slices, `
      + `C(${slices},${slices / 2})=${trainCombos.length} combinations, ${usedT} of ${observationsAvailable} `
      + `available synchronized observations used (${observationsAvailable - usedT} trailing observations `
      + `dropped for slice-size alignment). Paper's own suggested rejection threshold (p.14): PBO > 0.05. `
      + `simplifiedStochasticDominance is a mean-comparison proxy, not the paper's full CDF-based `
      + `first/second-order dominance test (out of scope for this pass) - do not over-interpret. `
      + `This is a read-only audit of the selection process, not proof the strategy is profitable - `
      + `it says nothing about backtest correctness (fill assumptions, look-ahead, costs).`,
  };
}
