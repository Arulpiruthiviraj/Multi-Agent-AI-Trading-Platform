import { describe, it, expect } from 'vitest';
import { assessDataQuality } from './dataQuality';
import { hashCanonicalDataset } from './datasetHash';
import { loadGoldenSmaDataset } from './loadGoldenDataset';
import { runSmaCrossover, signalUsesOnlyClosesThrough } from './smaCrossover';
import { researchSafety } from '../config/researchSafety';
import { compareEngines } from './VectorBTService';
import { deriveLifecycleStatus, emptyEvidence, liveGoNoGo, applyDegradation } from './promotionEngine';
import { classifyTradeEnvironment, isOrganicClosedPaper } from './organicPaper';
import { createPaperExperiment, experimentChangeRequiresNewVersion } from './paperExperiment';
import { labeledCapitals } from './capitalLabels';
import { classifyProbability, wilsonInterval } from './statsIntervals';
import { runGoldenWalkForward, purgedEmbargoSplit } from './walkForward';
import { permutationTestPnls, sensitivityAround, costStress } from './robustness';
import { coreStrategyInventory } from './strategyEvidence';
import { assertAllowlistedJob } from './VectorBTService';

describe('Phase 17 research evidence engine', () => {
  it('hashes the golden dataset stably', () => {
    const ds = loadGoldenSmaDataset();
    expect(hashCanonicalDataset(ds)).toBe(hashCanonicalDataset(ds));
    expect(hashCanonicalDataset(ds).startsWith('sha256:')).toBe(true);
  });

  it('requires data quality before treating backtest as promotion-grade', () => {
    const ds = loadGoldenSmaDataset();
    const q = assessDataQuality(ds);
    expect(q.backtestAllowed).toBe(true);
    expect(q.liveCandidateAllowed).toBe(false);
    const red = assessDataQuality({ ...ds, bars: [{ timestamp: 1, open: 1, high: 0.5, low: 2, close: 1, volume: 1 }] });
    expect(red.quality).toBe('RED');
    expect(red.backtestAllowed).toBe(false);
  });

  it('blocks duplicate timestamps as RED', () => {
    const ds = loadGoldenSmaDataset();
    const bars = [ds.bars[0], { ...ds.bars[0] }];
    expect(assessDataQuality({ ...ds, bars }).issues).toContain('duplicate_timestamps');
  });

  it('does not leak future close into SMA at T', () => {
    const ds = loadGoldenSmaDataset();
    expect(signalUsesOnlyClosesThrough(ds.bars, 3, 8, 10)).toBe(true);
  });

  it('runs deterministic golden SMA with next-bar open execution', () => {
    const ds = loadGoldenSmaDataset();
    const a = runSmaCrossover(ds.bars, researchSafety.goldenSmaFast, researchSafety.goldenSmaSlow, researchSafety.goldenInitialCapital);
    const b = runSmaCrossover(ds.bars, researchSafety.goldenSmaFast, researchSafety.goldenSmaSlow, researchSafety.goldenInitialCapital);
    expect(a.lookAheadModel).toBe('signal_at_T_execute_next_open');
    expect(a.tradeCount).toBe(b.tradeCount);
    expect(a.netPnl).toBe(b.netPnl);
  });

  it('flags ENGINE_MISMATCH instead of picking the better PnL', () => {
    const cmp = compareEngines({ tradeCount: 2, netPnl: 1 }, { tradeCount: 3, netPnl: 99 });
    expect(cmp.status).toBe('ENGINE_MISMATCH');
  });

  it('cannot promote empty evidence to VALIDATED or LIVE_CANDIDATE', () => {
    const e = emptyEvidence('MOMENTUM_BREAKOUT');
    expect(deriveLifecycleStatus(e)).toBe('UNTESTED');
    expect(liveGoNoGo(e).live).toBe('NO-GO');
    expect(liveGoNoGo(e).failedGates.length).toBeGreaterThan(5);
  });

  it('degrades on negative rolling expectancy', () => {
    const e = applyDegradation(emptyEvidence('X'), -1, 1);
    expect(deriveLifecycleStatus(e)).toBe('DEGRADED');
  });

  it('does not count UNKNOWN or test traces as organic paper', () => {
    expect(isOrganicClosedPaper({ status: 'FILLED', side: 'SELL', profitLoss: 10, traceId: 'test-1' })).toBe(false);
    expect(isOrganicClosedPaper({ status: 'REJECTED', side: 'SELL', profitLoss: 10, executionEnvironment: 'PAPER' })).toBe(false);
    expect(isOrganicClosedPaper({ status: 'FILLED', side: 'SELL', profitLoss: 10, executionEnvironment: 'BACKTEST' })).toBe(false);
    expect(isOrganicClosedPaper({ status: 'FILLED', side: 'SELL', profitLoss: 10, executionEnvironment: 'PAPER' })).toBe(true);
    expect(classifyTradeEnvironment({})).toBe('UNKNOWN');
  });

  it('freezes paper experiments so parameter changes need a new version', () => {
    const a = createPaperExperiment({ experimentId: 'ARGUS_CORE_2026_Q3', capital: 1000, universe: ['SPY'], timeframe: '5m' });
    expect(experimentChangeRequiresNewVersion(a, { experimentId: a.experimentId, capital: 5000, universe: ['SPY'], timeframe: '5m' })).toBe(true);
    expect(experimentChangeRequiresNewVersion(a, { experimentId: a.experimentId, capital: 1000, universe: ['SPY'], timeframe: '5m' })).toBe(false);
  });

  it('never fabricates broker equity', () => {
    const c = labeledCapitals({ researchInitialCapital: 10000, paperInitialCapital: 100000, argusAllocationBudget: 5000, brokerEquity: null, defaultMaxTradeSizeDollars: 3000 });
    expect(c.brokerEquityAvailable).toBe(false);
    expect(c.brokerEquity).toBeNull();
  });

  it('keeps LLM probabilities as MODEL_ESTIMATE, not empirical', () => {
    expect(classifyProbability(100, 30, 'llm')).toBe('MODEL_ESTIMATE');
    expect(classifyProbability(5, 30, 'empirical')).toBe('UNAVAILABLE');
    expect(wilsonInterval(10, 12)?.low).toBeLessThan(10 / 12);
  });

  it('walk-forward records only untouched test PnL and never optimizes on test', () => {
    const ds = loadGoldenSmaDataset();
    const wf = runGoldenWalkForward(ds.bars);
    expect(wf.optimizedOnTest).toBe(false);
    expect(wf.oosOnly).toBe(true);
    const split = purgedEmbargoSplit(100, 5);
    expect(split.testStart).toBe(split.trainEnd + 5);
  });

  it('permutation and sensitivity do not invent pass marks on empty trades', () => {
    const perm = permutationTestPnls([]);
    expect(perm.pass).toBe(false);
    const ds = loadGoldenSmaDataset();
    const sens = sensitivityAround(ds.bars, 3, 8, 10000);
    expect(sens.neighborhood.length).toBeGreaterThan(0);
    const cost = costStress(ds.bars, 3, 8, 10000, 0.5);
    expect(cost.multiples.map((m) => m.multiple)).toEqual([0, 1, 2, 3]);
  });

  it('CORE inventory stays UNTESTED with feature-translation adapters and no invented results', () => {
    const core = coreStrategyInventory();
    expect(core.map((c) => c.strategyId)).toEqual(researchSafety.coreStrategyIds);
    expect(core.every((c) => c.status === 'UNTESTED' && c.inventedResults === false && c.adapter === 'FEATURE_SUBSET_PARITY')).toBe(true);
  });

  it('refuses non-allowlisted research jobs', () => {
    expect(() => assertAllowlistedJob('rm_rf')).toThrow(/not allowlisted/);
  });
});
