import { describe, it, expect } from 'vitest';
import { applyNextBarLongFills, runCanonicalCoreBacktest, metricsFromClosedTrades } from './canonicalNextBarEngine';
import { loadGoldenSmaDataset } from './loadGoldenDataset';
import { researchSafety, isTheoreticalZeroCost } from '../config/researchSafety';
import { countMissingIntervals, assessDataQuality } from './dataQuality';
import { evidenceFromCanonicalRun, deriveLifecycleStatus, emptyEvidence } from './promotionEngine';
import { recordExperimentTrial, experimentLedgerSnapshot } from './experimentLedger';
import { runCoreWalkForward } from './coreWalkForward';
import { runCoreRobustness } from './coreRobustness';
import { reconcilePaperVsResearch } from './paperReconciliation';
import { tradingEdgeScore } from './edgeScore';
import { agentWeightUpdate } from './agentWeightPolicy';
import { tradingSafety } from '../config/tradingSafety';
import { recordResearchRun, latestRunForStrategy } from './researchRuns';

describe('Canonical NEXT_BAR CORE research', () => {
  it('fills BUY at next bar open, not the signal close', () => {
    const bars = [
      { timestamp: 1, open: 10, high: 11, low: 9, close: 10.5, volume: 1 },
      { timestamp: 2, open: 20, high: 21, low: 19, close: 20.5, volume: 1 },
      { timestamp: 3, open: 15, high: 16, low: 14, close: 15, volume: 1 },
    ];
    const { trades } = applyNextBarLongFills(bars, [
      { barIndex: 0, side: 'BUY', stop: null, target: null },
      { barIndex: 1, side: 'SELL', stop: null, target: null },
    ], { commissionPerShare: 0, spreadBps: 0, slippageBps: 0, qty: 1 });
    expect(trades).toHaveLength(1);
    expect(trades[0].fillBarIndex).toBe(2);
    expect(trades[0].fillPrice).toBe(15);
    expect(trades[0].pnl).toBe(15 - 20);
  });

  it('stop uses gap open when the bar opens through the stop', () => {
    const bars = [
      { timestamp: 1, open: 10, high: 11, low: 9, close: 10, volume: 1 },
      { timestamp: 2, open: 10, high: 10.5, low: 9.5, close: 10, volume: 1 },
      { timestamp: 3, open: 8, high: 8.5, low: 7, close: 8, volume: 1 },
    ];
    const { trades } = applyNextBarLongFills(bars, [
      { barIndex: 0, side: 'BUY', stop: 9, target: 12 },
    ], { commissionPerShare: 0, spreadBps: 0, slippageBps: 0, qty: 1 });
    expect(trades[0].exitReason).toBe('STOP');
    expect(trades[0].fillPrice).toBe(8);
  });

  it('golden CORE canonical run is not promotable on UNIT_FIXTURE even with non-zero costs', () => {
    expect(isTheoreticalZeroCost()).toBe(false);
    expect(researchSafety.commissionPerShare).toBeGreaterThan(0);
    expect(researchSafety.spreadBps).toBeGreaterThan(0);
    expect(researchSafety.slippageBps).toBeGreaterThan(0);
    expect(researchSafety.zeroCostBlocksPromotion).toBe(true);
    const ds = loadGoldenSmaDataset();
    const run = runCanonicalCoreBacktest({ strategyId: 'MOMENTUM_BREAKOUT', dataset: ds });
    expect(run.canPlaceOrders).toBe(false);
    expect(run.executionModel).toBe('NEXT_BAR_OPEN');
    expect(run.comparableToSameBarClose).toBe(false);
    expect(run.promotable).toBe(false);
    expect(run.backtestPass).toBe(false);
    expect(run.costModel).toBe('CONFIG');
    expect(run.provenance).toBe('UNIT_FIXTURE');
    const e = evidenceFromCanonicalRun(run);
    expect(deriveLifecycleStatus(e)).toBe('UNTESTED');
  });

  it('Sharpe is INSUFFICIENT_SAMPLE below minOosTrades', () => {
    const m = metricsFromClosedTrades([
      { side: 'SELL', signalBarIndex: 0, fillBarIndex: 1, fillPrice: 1, qty: 1, commission: 0, stop: null, target: null, exitReason: 'SIGNAL', pnl: 1, regime: null },
    ], researchSafety.minOosTrades);
    expect(m.sharpe.status).toBe('INSUFFICIENT_SAMPLE');
    expect(m.tradeCount).toBeLessThan(researchSafety.minOosTrades);
  });

  it('detects missing 1-minute intervals without fabricating bars', () => {
    const bars = [
      { timestamp: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { timestamp: 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { timestamp: 300_000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ];
    expect(countMissingIntervals(bars, '1Min')).toBe(3);
    const q = assessDataQuality({
      schemaVersion: 1, datasetId: 'gap', symbol: 'T', timezone: 'America/New_York', frequency: '1Min',
      adjustmentPolicy: 'raw', missingBarPolicy: 'keep', duplicatePolicy: 'reject', source: 'test',
      sourceVersion: '1', market: 'US', bars, provenance: 'UNIT_FIXTURE',
    });
    expect(q.missingIntervalCount).toBeGreaterThan(0);
    expect(q.liveCandidateAllowed).toBe(false);
  });

  it('dropped bars before grade cannot be silent GREEN', () => {
    const ds = loadGoldenSmaDataset();
    const q = assessDataQuality(ds, { droppedBarCount: 4 });
    expect(q.issues).toContain('bars_dropped_before_grade');
    expect(q.quality).not.toBe('GREEN');
  });

  it('experiment ledger increments and warns from the same config threshold', () => {
    const before = experimentLedgerSnapshot().trials;
    recordExperimentTrial('MOMENTUM_BREAKOUT', 'sha256:test');
    expect(experimentLedgerSnapshot().trials).toBe(before + 1);
  });

  it('CORE WFO on golden fixture is INSUFFICIENT_SAMPLE and not optimized on test', () => {
    const wf = runCoreWalkForward('MOMENTUM_BREAKOUT', loadGoldenSmaDataset());
    expect(wf.optimizedOnTest).toBe(false);
    expect(wf.comparableToSameBarClose).toBe(false);
    expect(wf.foldCount).toBeLessThan(researchSafety.minWalkForwardWindows);
    expect(wf.status).toBe('INSUFFICIENT_SAMPLE');
  });

  it('fixed WFO windows can produce minWalkForwardWindows folds without claiming promotion', () => {
    const day = 86_400_000;
    const bars = Array.from({ length: 150 }, (_, i) => ({
      timestamp: 1_700_000_000_000 + i * day,
      open: 100 + i * 0.01,
      high: 101 + i * 0.01,
      low: 99 + i * 0.01,
      close: 100.5 + i * 0.01,
      volume: 1_000_000,
    }));
    const ds = {
      ...loadGoldenSmaDataset(),
      bars,
      provenance: 'UNIT_FIXTURE' as const,
      datasetId: 'wfo_window_shape_only',
    };
    const wf = runCoreWalkForward('TREND_FOLLOWING', ds);
    expect(wf.foldCount).toBeGreaterThanOrEqual(researchSafety.minWalkForwardWindows);
    expect(wf.optimizedOnTest).toBe(false);
    expect(wf.executionModel).toBe('NEXT_BAR_OPEN');
  });

  it('CORE robustness on empty signals is INSUFFICIENT_SAMPLE not ROBUST', () => {
    const r = runCoreRobustness(loadGoldenSmaDataset().bars, []);
    expect(r.label).toBe('INSUFFICIENT_SAMPLE');
  });

  it('paper/research reconciliation does not invent divergence', () => {
    const rec = reconcilePaperVsResearch(null, []);
    expect(rec.status).toBe('UNAVAILABLE');
    expect(rec.invented).toBe(false);
  });

  it('edge score stays 8 on empty evidence', () => {
    const s = tradingEdgeScore(emptyEvidence('MOMENTUM_BREAKOUT'));
    expect(s.score).toBe(8);
    expect(s.band).toBe('0-20');
  });

  it('agent weights do not move below minSampleSizeForTrust', () => {
    const w = agentWeightUpdate({ totalEvaluated: 3, winRate: 1 });
    expect(w.statisticallyMeaningful).toBe(false);
    expect(w.currentWeight).toBe(1);
    expect(3).toBeLessThan(tradingSafety.minSampleSizeForTrust);
  });

  it('research run registry does not imply LIVE', () => {
    const run = runCanonicalCoreBacktest({ strategyId: 'MEAN_REVERSION', dataset: loadGoldenSmaDataset() });
    const rec = recordResearchRun(run);
    expect(latestRunForStrategy('MEAN_REVERSION')?.runId).toBe(rec.runId);
    expect(rec.manifest.canPlaceOrders).toBe(false);
  });
});
