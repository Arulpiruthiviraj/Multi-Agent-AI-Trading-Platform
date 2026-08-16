/**
 * Rolling walk-forward on the canonical NEXT_BAR CORE engine.
 * Optimize nothing on TEST. Median fold metrics, not the best fold.
 */
import { researchSafety } from '../config/researchSafety';
import { runCanonicalCoreBacktest } from './canonicalNextBarEngine';
import type { CanonicalDataset, ResearchBar } from './ohlcvTypes';

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
}

function sliceDataset(ds: CanonicalDataset, start: number, end: number): CanonicalDataset {
  return { ...ds, bars: ds.bars.slice(start, end), datasetId: `${ds.datasetId}_${start}_${end}` };
}

export function runCoreWalkForward(strategyId: string, dataset: CanonicalDataset): CoreWalkForwardReport {
  const bars: ResearchBar[] = dataset.bars;
  const n = bars.length;
  const embargo = researchSafety.wfoEmbargoBars;
  const minFolds = researchSafety.minWalkForwardWindows;
  const trainLen = Math.floor(n * 0.5);
  const valLen = Math.floor(n * 0.2);
  const testLen = Math.floor(n * 0.2);
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
    note: 'Canonical NEXT_BAR only. Not SAME_BAR BacktestEngine. Not promotion unless REAL_MARKET_DATA GREEN and foldCount >= minWalkForwardWindows.',
  };
  if (trainLen < 10 || valLen < 5 || testLen < 5) return base;

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
    });
    start += testLen;
  }

  if (folds.length < minFolds) {
    return { ...base, foldCount: folds.length, folds, status: 'INSUFFICIENT_SAMPLE' };
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
  };
}
