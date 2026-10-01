/**
 * Rolling walk-forward on the canonical NEXT_BAR CORE engine.
 * Optimize nothing on TEST. Median fold metrics, not the best fold.
 */
// @ts-nocheck

import { researchSafety } from '../config/researchSafety';
import { runCanonicalCoreBacktest } from './canonicalNextBarEngine';
import type { CanonicalDataset, ResearchBar } from './ohlcvTypes';
import { classifyRegime, MIN_BARS as REGIME_MIN_BARS, type RegimeLabel } from '../quant/RegimeEngine';

export interface CoreWalkForwardFold {
  trainStart: number;
  trainEnd: number;
  valStart: number;
  valEnd: number;
  testStart: number;
  testEnd: number;
  trainTrades: number;
  valTrades: number;
  testTrades: number;
  testNetPnl: number | null;
  testExpectancy: number | null;
  /**
   * Additive (2026-09-27, follow-up to this session's Master Redesign Plan Phase 4 finding):
   * the dominant RegimeLabel observed across the fold's TEST window only, using the SAME, already-
   * existing deterministic classifyRegime() (src/server/quant/RegimeEngine.ts) the live path uses -
   * no new regime classifier, no change to fold boundaries/selection/pass-fail status. Computed
   * causally (each point uses only bars up to and including itself, capped to a bounded trailing
   * lookback - never bars from later in the series). `null` when every point in the test window had
   * fewer than RegimeEngine's own MIN_BARS of real trailing history to classify honestly (e.g. very
   * early folds on a short dataset) - never fabricated.
   */
  dominantTestRegime: RegimeLabel | null;
}

/** Additive (2026-09-27): per-regime expectancy/Sharpe-proxy breakdown alongside the existing
 *  aggregate walk-forward result. Purely a reporting layer over folds already computed above -
 *  never used to re-select, re-weight, or re-order folds, and never changes `status`. */
export interface RegimeBreakdownEntry {
  regime: RegimeLabel;
  foldCount: number;
  medianTestExpectancy: number | null;
  medianTestNetPnl: number | null;
  /** Sample stdev of per-fold testExpectancy within this regime, or null with <2 samples. Used to
   *  derive a Sharpe-like ratio (mean expectancy / stdev) - not a real annualized Sharpe, since
   *  fold-level testExpectancy is not a return series. Labeled as such rather than overclaiming. */
  testExpectancyStdev: number | null;
  expectancyToStdevRatio: number | null;
}

export interface CoreWalkForwardReport {
  strategyId: string;
  executionModel: 'NEXT_BAR_OPEN';
  comparableToSameBarClose: false;
  optimizedOnTest: false;
  foldCount: number;
  medianTestExpectancy: number | null;
  medianTestNetPnl: number | null;
  status: 'INSUFFICIENT_SAMPLE' | 'FRAGILE' | 'COMPLETED';
  folds: CoreWalkForwardFold[];
  note: string;
  /** Additive (2026-09-27): per-regime breakdown, one entry per distinct dominantTestRegime that
   *  appeared across `folds` (folds with a null dominantTestRegime are excluded from this
   *  breakdown, not silently folded into another regime). Empty array, never fabricated, when no
   *  fold had enough real trailing history to classify a regime. */
  regimeBreakdown: RegimeBreakdownEntry[];
}

/** Bounded trailing lookback for regime classification within a fold's test window - large enough
 *  for RegimeEngine's own longest lookback feature (SMA200) when the dataset has that much real
 *  history, but capped so a long canonical dataset doesn't make this O(n) per fold-bar unbounded. */
const REGIME_LOOKBACK_CAP_BARS = 260;

/**
 * Dominant regime across a fold's TEST window, classified causally point-by-point (bar i uses only
 * bars [0..i], never bars after it) using the real, already-existing classifyRegime(). Points with
 * fewer than RegimeEngine's own MIN_BARS of real trailing history are skipped rather than forced
 * into a guess. Returns null (not a fabricated label) when zero points in the window were
 * classifiable.
 */
export function dominantRegimeForTestWindow(bars: ResearchBar[], testStart: number, testEnd: number): RegimeLabel | null {
  const counts = new Map<RegimeLabel, number>();
  for (let i = testStart; i < testEnd; i++) {
    const lookbackStart = Math.max(0, i + 1 - REGIME_LOOKBACK_CAP_BARS);
    const trailing = bars.slice(lookbackStart, i + 1);
    if (trailing.length < REGIME_MIN_BARS) continue;
    const result = classifyRegime(trailing);
    counts.set(result.regime, (counts.get(result.regime) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best: RegimeLabel | null = null;
  let bestCount = -1;
  for (const [regime, count] of counts) {
    if (count > bestCount) {
      best = regime;
      bestCount = count;
    }
  }
  return best;
}

function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function buildRegimeBreakdown(folds: CoreWalkForwardFold[]): RegimeBreakdownEntry[] {
  const byRegime = new Map<RegimeLabel, CoreWalkForwardFold[]>();
  for (const fold of folds) {
    if (fold.dominantTestRegime === null) continue;
    const list = byRegime.get(fold.dominantTestRegime) ?? [];
    list.push(fold);
    byRegime.set(fold.dominantTestRegime, list);
  }
  const entries: RegimeBreakdownEntry[] = [];
  for (const [regime, regimeFolds] of byRegime) {
    const expectancies = regimeFolds.map((f) => f.testExpectancy).filter((x): x is number => x != null);
    const pnls = regimeFolds.map((f) => f.testNetPnl).filter((x): x is number => x != null);
    const expStdev = stdev(expectancies);
    const meanExpectancy = expectancies.length > 0 ? expectancies.reduce((a, b) => a + b, 0) / expectancies.length : null;
    entries.push({
      regime,
      foldCount: regimeFolds.length,
      medianTestExpectancy: median(expectancies),
      medianTestNetPnl: median(pnls),
      testExpectancyStdev: expStdev,
      expectancyToStdevRatio: expStdev !== null && expStdev > 0 && meanExpectancy !== null ? meanExpectancy / expStdev : null,
    });
  }
  return entries;
}

function sliceDataset(ds: CanonicalDataset, start: number, end: number): CanonicalDataset {
  return { ...ds, bars: ds.bars.slice(start, end), datasetId: `${ds.datasetId}_${start}_${end}` };
}

export function runCoreWalkForward(strategyId: string, dataset: CanonicalDataset): CoreWalkForwardReport {
  const bars: ResearchBar[] = dataset.bars;
  const n = bars.length;
  const embargo = researchSafety.wfoEmbargoBars;
  const minFolds = researchSafety.minWalkForwardWindows;
  const trainLen = researchSafety.wfoTrainBars;
  const valLen = researchSafety.wfoValBars;
  const testLen = researchSafety.wfoTestBars;
  const base: CoreWalkForwardReport = {
    strategyId,
    executionModel: 'NEXT_BAR_OPEN',
    comparableToSameBarClose: false,
    optimizedOnTest: false,
    foldCount: 0,
    medianTestExpectancy: null,
    medianTestNetPnl: null,
    status: 'INSUFFICIENT_SAMPLE',
    folds: [],
    note: 'Canonical NEXT_BAR only. Rolling fixed windows from researchSafety.json. Not SAME_BAR BacktestEngine. Not promotion unless REAL_MARKET_DATA GREEN and foldCount >= minWalkForwardWindows.',
    regimeBreakdown: [],
  };
  if (trainLen < 10 || valLen < 5 || testLen < 5) return base;
  if (n < trainLen + valLen + embargo + testLen) return base;

  const folds: CoreWalkForwardFold[] = [];
  let start = 0;
  while (start + trainLen + valLen + embargo + testLen <= n) {
    const trainStart = start;
    const trainEnd = start + trainLen;
    const valStart = trainEnd;
    const valEnd = trainEnd + valLen;
    const testStart = valEnd + embargo;
    const testEnd = testStart + testLen;
    const train = runCanonicalCoreBacktest({ strategyId, dataset: sliceDataset(dataset, trainStart, trainEnd) });
    const val = runCanonicalCoreBacktest({ strategyId, dataset: sliceDataset(dataset, valStart, valEnd) });
    const test = runCanonicalCoreBacktest({ strategyId, dataset: sliceDataset(dataset, testStart, testEnd) });
    folds.push({
      trainStart,
      trainEnd,
      valStart,
      valEnd,
      testStart,
      testEnd,
      trainTrades: train.metrics.tradeCount,
      valTrades: val.metrics.tradeCount,
      testTrades: test.metrics.tradeCount,
      testNetPnl: test.metrics.netPnl,
      testExpectancy: test.metrics.expectancy,
      dominantTestRegime: dominantRegimeForTestWindow(bars, testStart, testEnd),
    });
    start += testLen;
  }

  if (folds.length < minFolds) {
    return { ...base, foldCount: folds.length, folds, status: 'INSUFFICIENT_SAMPLE', regimeBreakdown: buildRegimeBreakdown(folds) };
  }
  const expectancies = folds.map((f) => f.testExpectancy).filter((x): x is number => x != null).sort((a, b) => a - b);
  const pnls = folds.map((f) => f.testNetPnl).filter((x): x is number => x != null).sort((a, b) => a - b);
  const mid = (arr: number[]) => (arr.length ? arr[Math.floor(arr.length / 2)] : null);
  const medianExp = mid(expectancies);
  const positiveFolds = folds.filter((f) => (f.testExpectancy ?? 0) > 0).length;
  const fragile = positiveFolds <= 1;
  return {
    ...base,
    foldCount: folds.length,
    folds,
    medianTestExpectancy: medianExp,
    medianTestNetPnl: mid(pnls),
    status: fragile ? 'FRAGILE' : 'COMPLETED',
    regimeBreakdown: buildRegimeBreakdown(folds),
  };
}
