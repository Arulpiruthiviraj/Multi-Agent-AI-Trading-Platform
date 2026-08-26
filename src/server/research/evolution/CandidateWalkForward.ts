/**
 * Walk-forward for a parameterized candidate — mirrors coreWalkForward.ts's exact rolling
 * train/val/test/embargo fold logic (same researchSafety.json fold sizes, same "median fold, not
 * best fold" rule, same fail-closed INSUFFICIENT_SAMPLE/FRAGILE/COMPLETED classification) but
 * calls evaluateCandidate() per fold instead of the fixed-catalog runCanonicalCoreBacktest(). This
 * is the second half of the same bridge CandidateEvaluator.ts builds — reusing the fold-sizing
 * config and pass/fail rule, never inventing a second walk-forward methodology.
 */
import { researchSafety } from '../../config/researchSafety';
import type { CanonicalDataset } from '../ohlcvTypes';
import type { StrategyDefinition } from '../../strategiesEngine/core/types';
import { evaluateCandidate } from './CandidateEvaluator';
import type { CoreWalkForwardFold, CoreWalkForwardReport } from '../coreWalkForward';

function sliceDataset(ds: CanonicalDataset, start: number, end: number): CanonicalDataset {
  return { ...ds, bars: ds.bars.slice(start, end), datasetId: `${ds.datasetId}_${start}_${end}` };
}

export function runCandidateWalkForward(candidate: StrategyDefinition, dataset: CanonicalDataset): CoreWalkForwardReport {
  const n = dataset.bars.length;
  const embargo = researchSafety.wfoEmbargoBars;
  const minFolds = researchSafety.minWalkForwardWindows;
  const trainLen = researchSafety.wfoTrainBars;
  const valLen = researchSafety.wfoValBars;
  const testLen = researchSafety.wfoTestBars;
  const base: CoreWalkForwardReport = {
    strategyId: candidate.id,
    executionModel: 'NEXT_BAR_OPEN',
    comparableToSameBarClose: false,
    optimizedOnTest: false,
    foldCount: 0,
    medianTestExpectancy: null,
    medianTestNetPnl: null,
    status: 'INSUFFICIENT_SAMPLE',
    folds: [],
    note: 'Candidate walk-forward (research/evolution) — same fold sizing/rule as coreWalkForward.ts, evaluated via evaluateCandidate() instead of the fixed quant/strategies catalog.',
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
    const train = evaluateCandidate(candidate, sliceDataset(dataset, trainStart, trainEnd));
    const val = evaluateCandidate(candidate, sliceDataset(dataset, valStart, valEnd));
    const test = evaluateCandidate(candidate, sliceDataset(dataset, testStart, testEnd));
    folds.push({
      trainStart, trainEnd, valStart, valEnd, testStart, testEnd,
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
  const positiveFolds = folds.filter((f) => (f.testExpectancy ?? 0) > 0).length;
  const fragile = positiveFolds <= 1;
  return {
    ...base,
    foldCount: folds.length,
    folds,
    medianTestExpectancy: mid(expectancies),
    medianTestNetPnl: mid(pnls),
    status: fragile ? 'FRAGILE' : 'COMPLETED',
  };
}
