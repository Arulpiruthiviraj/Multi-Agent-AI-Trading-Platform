/**
 * ==========================================================
 * Module: quant/analysis/MonteCarlo
 *
 * Purpose:
 * E6 (BACKTEST_QUANT_HARDENING_ANALYSIS.md), Phase 14 of the original audit request - bootstrap
 * resampling over a REAL completed backtest's closed-trade R-multiples, never a fabricated
 * distribution (e.g. an assumed normal/theoretical win-rate). Explicitly labeled SCENARIO
 * ANALYSIS, per the audit's own explicit instruction: "Never use Monte Carlo output as proof of
 * future profitability." This module produces no side effects and is never wired into any live
 * trading decision - it is a pure, offline research function over a trade log the caller already
 * has (typically a completed BacktestEngine.runStrategyBacktest() result).
 * ==========================================================
 */
import { MIN_SAMPLE_SIZE_FOR_KELLY } from '../risk/ExpectedValue';
import { tradingSafety } from '../../config/tradingSafety';

export interface MonteCarloConfig {
  /** Real closed-trade R-multiples from a completed backtest (tradeLog[].rMultiple for SELLs) -
   *  never invented. Order does not matter; resampling is with replacement. */
  rMultiples: number[];
  /** Real starting capital for the simulated equity curve. */
  initialCapital: number;
  /** Fraction of capital risked per trade (e.g. 0.02 for 2%) - applied to each resampled R-multiple
   *  as equity *= (1 + riskPerTradePct * rMultiple), the standard R-multiple equity model. */
  riskPerTradePct: number;
  /** Trades per simulated path. Defaults to rMultiples.length (a "one more equivalent sequence"
   *  scenario) - never invented beyond what the caller specifies. */
  pathLength?: number;
  /** Number of independent resampled paths. Default 2000 - enough for stable percentiles without
   *  being needlessly slow for an interactive request. */
  simulations?: number;
  /** Drawdown tolerance as a fraction of peak (e.g. 0.15). Used for probabilityOfDrawdownExceeding. */
  maxDrawdownTolerance?: number;
}

export interface MonteCarloResult {
  scenarioAnalysis: true; // always present as an explicit label - never omitted, never a prediction
  statisticallyJustified: boolean; // false below MIN_SAMPLE_SIZE_FOR_KELLY real closed trades
  sampleSize: number;
  simulations: number;
  pathLength: number;
  endingEquity: { p5: number; p25: number; p50: number; p75: number; p95: number; mean: number };
  maxDrawdownPct: { p50: number; p95: number; worst: number };
  maxLosingStreak: { p50: number; p95: number; worst: number };
  /** Real fraction of simulated paths that ended below where they started - a bootstrap proxy for
   *  "risk of ruin" over this many trades at this risk-per-trade, not a theoretical formula. */
  probabilityOfLoss: number;
  /** Fraction of bootstrap paths whose max drawdown (decimal) met or exceeded maxDrawdownTolerance. */
  probabilityOfDrawdownExceeding?: number;
  note: string | null;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

/** Mulberry32 - deterministic, seedable PRNG so a given seed reproduces the exact same paths
 *  (real reproducibility for a scenario report, not Math.random()'s untestable nondeterminism). */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function runMonteCarlo(config: MonteCarloConfig, seed = tradingSafety.monteCarloDefaultSeed): MonteCarloResult {
  const sampleSize = config.rMultiples.length;
  const simulations = config.simulations ?? 2000;
  const pathLength = config.pathLength ?? sampleSize;
  const statisticallyJustified = sampleSize >= MIN_SAMPLE_SIZE_FOR_KELLY;

  if (sampleSize === 0 || pathLength === 0) {
    return {
      scenarioAnalysis: true, statisticallyJustified: false, sampleSize, simulations: 0, pathLength: 0,
      endingEquity: { p5: config.initialCapital, p25: config.initialCapital, p50: config.initialCapital, p75: config.initialCapital, p95: config.initialCapital, mean: config.initialCapital },
      maxDrawdownPct: { p50: 0, p95: 0, worst: 0 },
      maxLosingStreak: { p50: 0, p95: 0, worst: 0 },
      probabilityOfLoss: 0,
      note: 'No real closed trades to resample from - cannot run a scenario analysis.',
    };
  }

  const rng = mulberry32(seed);
  const endingEquities: number[] = [];
  const maxDrawdowns: number[] = [];
  const maxStreaks: number[] = [];
  let lossCount = 0;
  let ddExceedCount = 0;
  const ddTol = config.maxDrawdownTolerance;

  for (let s = 0; s < simulations; s++) {
    let equity = config.initialCapital;
    let peak = equity;
    let maxDd = 0;
    let streak = 0;
    let maxStreak = 0;

    for (let t = 0; t < pathLength; t++) {
      const r = config.rMultiples[Math.floor(rng() * sampleSize)];
      equity *= 1 + config.riskPerTradePct * r;
      equity = Math.max(0, equity);
      peak = Math.max(peak, equity);
      const dd = peak > 0 ? (peak - equity) / peak : 0;
      maxDd = Math.max(maxDd, dd);
      if (r < 0) { streak++; maxStreak = Math.max(maxStreak, streak); } else { streak = 0; }
    }

    endingEquities.push(equity);
    maxDrawdowns.push(Number((maxDd * 100).toFixed(2)));
    maxStreaks.push(maxStreak);
    if (equity < config.initialCapital) lossCount++;
    if (typeof ddTol === 'number' && Number.isFinite(ddTol) && maxDd >= ddTol) ddExceedCount++;
  }

  const sortedEquity = [...endingEquities].sort((a, b) => a - b);
  const sortedDd = [...maxDrawdowns].sort((a, b) => a - b);
  const sortedStreak = [...maxStreaks].sort((a, b) => a - b);
  const mean = endingEquities.reduce((a, b) => a + b, 0) / endingEquities.length;

  return {
    scenarioAnalysis: true,
    statisticallyJustified,
    sampleSize,
    simulations,
    pathLength,
    endingEquity: {
      p5: Number(percentile(sortedEquity, 0.05).toFixed(2)),
      p25: Number(percentile(sortedEquity, 0.25).toFixed(2)),
      p50: Number(percentile(sortedEquity, 0.50).toFixed(2)),
      p75: Number(percentile(sortedEquity, 0.75).toFixed(2)),
      p95: Number(percentile(sortedEquity, 0.95).toFixed(2)),
      mean: Number(mean.toFixed(2)),
    },
    maxDrawdownPct: {
      p50: percentile(sortedDd, 0.50),
      p95: percentile(sortedDd, 0.95),
      worst: sortedDd[sortedDd.length - 1],
    },
    maxLosingStreak: {
      p50: percentile(sortedStreak, 0.50),
      p95: percentile(sortedStreak, 0.95),
      worst: sortedStreak[sortedStreak.length - 1],
    },
    probabilityOfLoss: Number((lossCount / simulations).toFixed(4)),
    probabilityOfDrawdownExceeding: typeof ddTol === 'number' && Number.isFinite(ddTol)
      ? Number((ddExceedCount / simulations).toFixed(4))
      : undefined,
    note: statisticallyJustified
      ? null
      : `Resampled from only ${sampleSize} real closed trades (below the ${MIN_SAMPLE_SIZE_FOR_KELLY}-trade threshold this codebase uses elsewhere for statistical trust) - treat these percentiles as illustrative, not reliable.`,
  };
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * One-sided permutation p-value for H0: mean R = 0.
 * Sign-flips observed R-multiples; p = share of |mean_perm| >= |mean_obs|.
 */
export function permutationTestMeanEdge(rMultiples: number[], permutations = tradingSafety.permutationTestIterations, seed = tradingSafety.monteCarloDefaultSeed): {
  observedMeanR: number;
  pValue: number;
  permutations: number;
  statisticallyJustified: boolean;
} {
  const n = rMultiples.length;
  const observedMeanR = mean(rMultiples);
  if (n === 0) {
    return { observedMeanR: 0, pValue: 1, permutations: 0, statisticallyJustified: false };
  }
  const rng = mulberry32(seed);
  const obsAbs = Math.abs(observedMeanR);
  let extreme = 0;
  for (let i = 0; i < permutations; i++) {
    let s = 0;
    for (const r of rMultiples) s += rng() < 0.5 ? -r : r;
    if (Math.abs(s / n) >= obsAbs - 1e-15) extreme++;
  }
  return {
    observedMeanR: Number(observedMeanR.toFixed(6)),
    pValue: Number((extreme / permutations).toFixed(6)),
    permutations,
    statisticallyJustified: n >= MIN_SAMPLE_SIZE_FOR_KELLY,
  };
}

export const STATISTICALLY_INSIGNIFICANT = 'STATISTICALLY_INSIGNIFICANT';
export const OVERFIT_REJECTED = 'OVERFIT_REJECTED';

/** Must match BacktestEngine's daily Sharpe annualization. */
export const SHARPE_PERIODS_PER_YEAR = tradingSafety.tradingDaysPerYear;

export function periodReturnsFromEquityCurve(equityCurve: Array<{ equity: number }>): number[] {
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    const cur = equityCurve[i].equity;
    if (prev > 0) returns.push((cur - prev) / prev);
  }
  return returns;
}

export function annualizedSharpe(returns: number[], periodsPerYear = SHARPE_PERIODS_PER_YEAR): number {
  if (returns.length === 0) return 0;
  const m = mean(returns);
  const std = Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - m, 2), 0) / returns.length);
  if (!(std > 0)) return 0;
  return (m / std) * Math.sqrt(periodsPerYear);
}

/**
 * Empirical p-value for Sharpe under H0: mean period return = 0.
 * Sign-flips the observed return series (destroys signed serial correlation and any directional
 * edge while preserving volatility). Order-shuffle alone cannot test Sharpe: sample mean/std
 * of a fixed vector are permutation-invariant.
 */
export function permutationTestSharpe(
  returns: number[],
  permutations: number = tradingSafety.permutationTestIterations,
  alpha: number = tradingSafety.permutationSignificanceAlpha,
  seed = tradingSafety.monteCarloDefaultSeed,
): {
  observedSharpe: number;
  pValue: number;
  permutations: number;
  alpha: number;
  verdict: typeof STATISTICALLY_INSIGNIFICANT | 'SIGNIFICANT' | 'INSUFFICIENT_SAMPLE';
  statisticallyJustified: boolean;
} {
  const n = returns.length;
  const observedSharpe = annualizedSharpe(returns);
  if (n < 2) {
    return {
      observedSharpe,
      pValue: 1,
      permutations: 0,
      alpha,
      verdict: 'INSUFFICIENT_SAMPLE',
      statisticallyJustified: false,
    };
  }
  const rng = mulberry32(seed);
  let extreme = 0;
  for (let i = 0; i < permutations; i++) {
    const perm = returns.map(r => (rng() < 0.5 ? -r : r));
    if (annualizedSharpe(perm) >= observedSharpe - 1e-12) extreme++;
  }
  const pValue = Number((extreme / permutations).toFixed(6));
  const justified = n >= MIN_SAMPLE_SIZE_FOR_KELLY;
  const verdict = pValue > alpha ? STATISTICALLY_INSIGNIFICANT : 'SIGNIFICANT';
  return {
    observedSharpe: Number(observedSharpe.toFixed(6)),
    pValue,
    permutations,
    alpha,
    verdict,
    statisticallyJustified: justified,
  };
}

export function evaluateOosSharpeDegradation(
  sharpeIs: number,
  sharpeOos: number,
  minRatio: number = tradingSafety.oosSharpeDegradationMinRatio,
): {
  ratio: number | null;
  rejected: boolean;
  reason: string;
} {
  if (!Number.isFinite(sharpeIs) || !Number.isFinite(sharpeOos)) {
    return { ratio: null, rejected: true, reason: 'Non-finite Sharpe — fail-closed.' };
  }
  if (sharpeIs <= 0) {
    return { ratio: null, rejected: true, reason: 'In-sample Sharpe <= 0 — cannot claim a transferable edge.' };
  }
  const ratio = sharpeOos / sharpeIs;
  const rejected = ratio < minRatio;
  return {
    ratio: Number(ratio.toFixed(4)),
    rejected,
    reason: rejected
      ? `OOS/IS Sharpe ${ratio.toFixed(4)} < ${minRatio} — reject strategy.`
      : `OOS/IS Sharpe ${ratio.toFixed(4)} meets minimum ${minRatio}.`,
  };
}

export function evaluateOosWinRate(
  oosWinRatePct: number,
  minPct: number = tradingSafety.oosWinRateMinPct,
): { passed: boolean; oosWinRatePct: number; minPct: number; reason: string } {
  const passed = Number.isFinite(oosWinRatePct) && oosWinRatePct >= minPct;
  return {
    passed,
    oosWinRatePct,
    minPct,
    reason: passed
      ? `OOS win rate ${oosWinRatePct.toFixed(1)}% meets profitability floor ${minPct}%.`
      : `OOS win rate ${oosWinRatePct.toFixed(1)}% < profitability floor ${minPct}%.`,
  };
}

export type WalkForwardHarnessVerdict = 'PASS' | 'OVERFIT_REJECTED' | 'INSUFFICIENT_PERIODS';

export function evaluateWalkForwardHarness(input: {
  periodCount: number;
  avgSharpeIS: number;
  avgSharpeOOS: number;
  avgOosWinRatePct: number;
  minPeriods?: number;
}): {
  verdict: WalkForwardHarnessVerdict;
  oosSharpeDegradation: ReturnType<typeof evaluateOosSharpeDegradation>;
  oosWinRate: ReturnType<typeof evaluateOosWinRate>;
  reason: string;
} {
  const oosSharpeDegradation = evaluateOosSharpeDegradation(input.avgSharpeIS, input.avgSharpeOOS);
  const oosWinRate = evaluateOosWinRate(input.avgOosWinRatePct);
  const overfit = oosSharpeDegradation.rejected || !oosWinRate.passed;
  if (overfit) {
    return {
      verdict: 'OVERFIT_REJECTED',
      oosSharpeDegradation,
      oosWinRate,
      reason: [
        oosSharpeDegradation.rejected ? oosSharpeDegradation.reason : null,
        !oosWinRate.passed ? oosWinRate.reason : null,
      ].filter(Boolean).join(' '),
    };
  }
  const minPeriods = input.minPeriods ?? 5;
  if (input.periodCount < minPeriods) {
    return {
      verdict: 'INSUFFICIENT_PERIODS',
      oosSharpeDegradation,
      oosWinRate,
      reason: `Only ${input.periodCount} walk-forward period(s) - too few to claim OOS robustness.`,
    };
  }
  return {
    verdict: 'PASS',
    oosSharpeDegradation,
    oosWinRate,
    reason: oosSharpeDegradation.reason,
  };
}
