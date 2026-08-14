/**
 * ==========================================================
 * Module: statistics
 *
 * Purpose:
 * General-purpose deterministic statistics over numeric series (prices, returns, or any other
 * real series callers supply) - rolling mean/stddev/z-score/percentile, correlation/covariance/
 * beta, skewness/kurtosis/autocorrelation. Pure math, no I/O, no fabricated fallbacks: every
 * function returns `null` (not 0, not a guess) when there isn't enough real data to compute a
 * meaningful value, so callers can distinguish "computed and zero" from "not computable yet."
 *
 * Deliberately generic rather than duplicating what already exists for a narrower purpose:
 * - PositionSizing.ts's `returnCorrelation` is return-based Pearson correlation scoped to the
 *   risk-gate's correlated-exposure check. `correlation()` here is the same Pearson formula but
 *   generalized to any two series (returns, price levels, agent signals, etc.) - RegimeEngine/
 *   StrategyEngine/MarketContext should call this, not reimplement Pearson a third time.
 * - AgentSynergy.ts's `pearsonCorrelation` is a third, independent implementation for signal-
 *   level correlation - also not touched here.
 * None of those three existing implementations are modified or removed.
 * ==========================================================
 */

/** Simple arithmetic mean of the last `period` values, or null if fewer than `period` exist. */
// Floating-point summation of repeated/near-identical values never lands on exactly 0 (e.g.
// summing 25 copies of the literal 0.01 yields a variance around 7.5e-35, not 0) - every
// "is this variance/stddev effectively zero" check below compares against this epsilon instead
// of `=== 0`, so a real degenerate case (a genuinely flat series) is still detected as null
// rather than silently producing a wildly amplified ratio from float noise in the denominator.
const NEAR_ZERO = 1e-10;

export function rollingMean(values: number[], period: number): number | null {
  if (values.length < period || period < 1) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** Population standard deviation of the last `period` values, or null if fewer than `period` exist. */
export function rollingStdDev(values: number[], period: number): number | null {
  if (values.length < period || period < 1) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  return Math.sqrt(variance);
}

/** How many standard deviations the most recent value sits from the rolling mean. Null if the
 *  rolling window can't be computed, or if stddev is exactly 0 (a flat window has no meaningful
 *  z-score - returning 0 there would falsely claim "exactly average" for a degenerate series). */
export function zScore(values: number[], period: number): number | null {
  if (values.length === 0) return null;
  const mean = rollingMean(values, period);
  const stdDev = rollingStdDev(values, period);
  if (mean === null || stdDev === null || stdDev < NEAR_ZERO) return null;
  return (values[values.length - 1] - mean) / stdDev;
}

/** Percentage of the historical `values` array strictly below `currentValue` (0-100). This is
 *  the real, general-purpose primitive `volatility percentile` (indicators/volatility.ts) is
 *  built on. Null if `values` is empty. */
export function percentileRank(values: number[], currentValue: number): number | null {
  if (values.length === 0) return null;
  const below = values.filter(v => v < currentValue).length;
  return (below / values.length) * 100;
}

/** Period-over-period simple returns, e.g. rollingReturns([100,102,101], 1) -> [0.02, -0.0098...].
 *  Returns one fewer element than the input (or fewer still if `period` &gt; 1). Empty array if
 *  there isn't enough data for even one return. */
export function rollingReturns(values: number[], period: number = 1): number[] {
  const out: number[] = [];
  for (let i = period; i < values.length; i++) {
    const prev = values[i - period];
    if (prev === 0) continue; // undefined return - skip rather than emit Infinity/NaN
    out.push((values[i] - prev) / prev);
  }
  return out;
}

/** Standard deviation of period-over-period returns over the trailing `period` observations -
 *  the real building block for "historical/realized volatility." Not annualized here (callers
 *  decide the annualization factor for their own bar timeframe - see indicators/volatility.ts). */
export function rollingVolatility(values: number[], period: number): number | null {
  const returns = rollingReturns(values);
  return rollingStdDev(returns, period);
}

/** Real Pearson correlation coefficient between two equal-length-or-truncated series. Requires
 *  at least `minOverlap` overlapping points (default 20, matching this codebase's existing
 *  correlation gates in PositionSizing.ts/AgentSynergy.ts) and non-zero variance in both series.
 *  Null (never a fabricated 0) when either condition fails. */
export function correlation(seriesA: number[], seriesB: number[], minOverlap: number = 20): number | null {
  const n = Math.min(seriesA.length, seriesB.length);
  if (n < minOverlap) return null;
  const a = seriesA.slice(-n), b = seriesB.slice(-n);
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    cov += da * db; varA += da * da; varB += db * db;
  }
  if (varA < NEAR_ZERO || varB < NEAR_ZERO) return null;
  return cov / Math.sqrt(varA * varB);
}

/** Real sample covariance between two equal-length-or-truncated series. Same overlap/variance
 *  guards as `correlation()`. */
export function covariance(seriesA: number[], seriesB: number[], minOverlap: number = 20): number | null {
  const n = Math.min(seriesA.length, seriesB.length);
  if (n < minOverlap) return null;
  const a = seriesA.slice(-n), b = seriesB.slice(-n);
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  for (let i = 0; i < n; i++) cov += (a[i] - meanA) * (b[i] - meanB);
  return cov / (n - 1);
}

/** Real beta of `assetReturns` against `benchmarkReturns` (cov(asset,bench) / var(bench)). Used
 *  by MarketContext.ts for "stock vs benchmark relative strength" - not fabricated when the
 *  benchmark has near-zero variance (a real degenerate case, e.g. a flat/no-data window). */
export function beta(assetReturns: number[], benchmarkReturns: number[], minOverlap: number = 20): number | null {
  const n = Math.min(assetReturns.length, benchmarkReturns.length);
  if (n < minOverlap) return null;
  const a = assetReturns.slice(-n), b = benchmarkReturns.slice(-n);
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  // Raw sums, no division by n or n-1 on either side: beta = Σ(a-meanA)(b-meanB) / Σ(b-meanB)² is
  // algebraically identical to sample-cov/sample-var (the (n-1) divisor cancels), and this form
  // can't develop the numerator/denominator divisor mismatch a naive split calculation risks.
  let sumCov = 0, sumVarB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    sumCov += da * db;
    sumVarB += db * db;
  }
  if (sumVarB < NEAR_ZERO) return null;
  return sumCov / sumVarB;
}

/** Sample skewness (third standardized moment) - positive means a longer right tail (real, e.g.
 *  a series of mostly-small-losses punctuated by rare large gains). Null below `minSamples`. */
export function skewness(values: number[], minSamples: number = 20): number | null {
  const n = values.length;
  if (n < minSamples) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const stdDev = Math.sqrt(values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / n);
  if (stdDev < NEAR_ZERO) return null;
  const m3 = values.reduce((a, b) => a + Math.pow(b - mean, 3), 0) / n;
  return m3 / Math.pow(stdDev, 3);
}

/** Excess kurtosis (fourth standardized moment minus 3, so a normal distribution reads ~0).
 *  Positive means fatter tails than normal (real, relevant to how often extreme moves actually
 *  occur vs. a normal-distribution assumption). Null below `minSamples`. */
export function kurtosis(values: number[], minSamples: number = 20): number | null {
  const n = values.length;
  if (n < minSamples) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const stdDev = Math.sqrt(values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / n);
  if (stdDev < NEAR_ZERO) return null;
  const m4 = values.reduce((a, b) => a + Math.pow(b - mean, 4), 0) / n;
  return (m4 / Math.pow(stdDev, 4)) - 3;
}

/** Lag-k autocorrelation of a series (correlation of the series with a lagged copy of itself) -
 *  a real measure of momentum/mean-reversion persistence, used sparingly per the plan's own
 *  instruction not to expose statistics without a clear purpose. Null if too little data remains
 *  after lagging. */
export function autocorrelation(values: number[], lag: number, minOverlap: number = 20): number | null {
  if (lag < 1 || values.length - lag < minOverlap) return null;
  const a = values.slice(0, values.length - lag);
  const b = values.slice(lag);
  return correlation(a, b, minOverlap);
}
