/**
 * Walk-Forward (Phase 5). Extends the existing graduation framework — reuses runCoreWalkForward()
 * (coreWalkForward.ts, rolling fixed-window train/val/test/embargo folds on the canonical NEXT_BAR
 * engine, median-fold not best-fold) and classifies the result against the existing
 * StrategyLifecycleStatus ladder (promotionEngine.ts) rather than inventing a second one. Never
 * promotes automatically — returns a classification only; a human/registry decision still gates
 * any actual status change.
 */
import { runCoreWalkForward, CoreWalkForwardReport } from '../coreWalkForward';
import type { CanonicalDataset } from '../ohlcvTypes';
import type { StrategyLifecycleStatus } from '../promotionEngine';
import { wrapResearchResult, ResearchResult, DataQualityMeta } from './types';
import { emitResearchEvent } from './researchEventLog';

export interface WalkForwardClassification {
  report: CoreWalkForwardReport;
  /** Advisory only — never auto-applied to any registry. */
  suggestedLifecycleStatus: StrategyLifecycleStatus;
  reason: string;
}

function classify(report: CoreWalkForwardReport): { status: StrategyLifecycleStatus; reason: string } {
  if (report.status === 'INSUFFICIENT_SAMPLE') {
    return { status: 'BACKTEST_ONLY', reason: `Only ${report.foldCount} walk-forward fold(s) completed — not enough for a walk-forward read yet.` };
  }
  if (report.status === 'FRAGILE') {
    return { status: 'OOS_TESTING', reason: `${report.foldCount} folds ran, but at most 1 had positive out-of-sample expectancy — fragile, stays at OOS testing, does not advance to WALK_FORWARD_TESTING.` };
  }
  return {
    status: (report.medianTestExpectancy ?? 0) > 0 ? 'WALK_FORWARD_TESTING' : 'OOS_TESTING',
    reason: (report.medianTestExpectancy ?? 0) > 0
      ? `${report.foldCount} folds, median out-of-sample expectancy ${report.medianTestExpectancy?.toFixed(4)} — real walk-forward evidence exists, still requires SHADOW/PAPER evidence before any further promotion.`
      : `${report.foldCount} folds completed but median out-of-sample expectancy is not positive (${report.medianTestExpectancy}) — does not advance past OOS testing.`,
  };
}

export function runWalkForwardResearch(opts: {
  strategyId: string;
  dataset: CanonicalDataset;
  traceId?: string;
}): ResearchResult<WalkForwardClassification> {
  const report = runCoreWalkForward(opts.strategyId, opts.dataset);
  const { status, reason } = classify(report);

  const dataQuality: DataQualityMeta = {
    source: 'coreWalkForward.runCoreWalkForward (reused, unchanged) + promotionEngine.StrategyLifecycleStatus (reused ladder)',
    symbol: opts.dataset.symbol,
    timeframe: opts.dataset.frequency,
    timestamp: new Date().toISOString(),
    sampleSize: report.foldCount,
    missingFields: report.status === 'INSUFFICIENT_SAMPLE' ? ['insufficient bars for the configured fold count'] : [],
    staleness: 'FRESH',
    assumptions: ['NEXT_BAR_OPEN only; rolling fixed windows from researchSafety.json; optimizes nothing on the test fold.'],
    quality: report.status === 'COMPLETED' ? 'GREEN' : report.status === 'FRAGILE' ? 'YELLOW' : 'UNAVAILABLE',
  };

  const result = wrapResearchResult({
    capability: 'WALK_FORWARD',
    label: 'RESEARCH',
    dataQuality,
    data: { report, suggestedLifecycleStatus: status, reason },
  });
  emitResearchEvent('WALK_FORWARD_COMPLETED', {
    researchRunId: result.researchRunId,
    traceId: opts.traceId,
    symbol: opts.dataset.symbol,
    strategyId: opts.strategyId,
    foldCount: report.foldCount,
    status: report.status,
    suggestedLifecycleStatus: status,
  });
  return result;
}
