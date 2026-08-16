import { describe, it, expect } from 'vitest';
import { loadGoldenSmaDataset } from './loadGoldenDataset';
import { importResearchDataset, assertNoArbitraryCode, isPromotableProvenance } from './importDataset';
import { replayArgusStrategy } from './argusStrategyReplay';
import { rejectUnclosedDailyInIntraday } from './lookAheadMtf';
import { deriveLifecycleStatus, emptyEvidence } from './promotionEngine';
import { loadStrategySpec } from './strategySpecs';
import { quantThresholds } from '../config/quantThresholds';
import { multipleTestingWarning } from './multipleTesting';
import { researchSafety } from '../config/researchSafety';
import { researchKelly } from './kellyResearch';
import { researchComparisonMatrix } from './strategyEvidence';
import { getExecutionModel } from './executionModel';
import { hashCanonicalDataset } from './datasetHash';

describe('Phase 18 research validation', () => {
  it('labels golden SMA as UNIT_FIXTURE and not promotable', () => {
    const ds = loadGoldenSmaDataset();
    expect(ds.provenance).toBe('UNIT_FIXTURE');
    expect(isPromotableProvenance(ds.provenance!)).toBe(false);
  });

  it('imports CSV as UNIT_FIXTURE without counting toward promotion', () => {
    const meta = importResearchDataset({
      datasetId: 'csv_unit_1',
      symbol: 'TEST',
      provenance: 'UNIT_FIXTURE',
      csv: 'timestamp,open,high,low,close,volume\n1,1,1,1,1,1\n2,2,2,2,2,2',
    });
    expect(meta.rowCount).toBe(2);
    expect(meta.provenance).toBe('UNIT_FIXTURE');
    expect(meta.dataHash.startsWith('sha256:')).toBe(true);
  });

  it('rejects arbitrary code keys on import payload', () => {
    expect(() => assertNoArbitraryCode({ eval: '1' })).toThrow(/not allowed/);
    expect(() => assertNoArbitraryCode({ submitOrder: true })).toThrow(/not allowed/);
  });

  it('Argus CORE replay on golden fixture is INSUFFICIENT_SAMPLE and not promotable', () => {
    const ds = loadGoldenSmaDataset();
    const r = replayArgusStrategy({ strategyId: 'MOMENTUM_BREAKOUT', bars: ds.bars, provenance: ds.provenance ?? 'UNIT_FIXTURE' });
    expect(r.canPlaceOrders).toBe(false);
    expect(r.vectorbtParity).toBe('FEATURE_TRANSLATION');
    expect(r.rejection).toBe('INSUFFICIENT_SAMPLE');
    expect(r.promotable).toBe(false);
  });

  it('detects unclosed daily feature look-ahead', () => {
    expect(rejectUnclosedDailyInIntraday({ decisionTimestamp: 1000, dailyBarOpenMs: 0, dailyBarCloseMs: 5000 })).toBe('LOOKAHEAD_DETECTED');
    expect(rejectUnclosedDailyInIntraday({ decisionTimestamp: 5000, dailyBarOpenMs: 0, dailyBarCloseMs: 5000 })).toBe('OK');
  });

  it('strategy spec numbers come from quantThresholds.json', () => {
    const spec = loadStrategySpec('MOMENTUM_BREAKOUT') as any;
    expect(spec.thresholds.rvolThreshold).toBe(quantThresholds.rvolThreshold);
    expect(spec.vectorbtParity).toBe('FEATURE_TRANSLATION');
    expect(spec.sourceFile).toContain('momentumBreakout.ts');
  });

  it('all-true evidence on UNIT_FIXTURE still UNTESTED', () => {
    const e = emptyEvidence('MEAN_REVERSION');
    e.dataProvenance = 'UNIT_FIXTURE';
    e.dataQualityPass = true;
    e.backtestPass = true;
    e.oosPass = true;
    e.walkForwardPass = true;
    e.monteCarloPass = true;
    e.permutationPass = true;
    e.sensitivityPass = true;
    e.costStressPass = true;
    e.paperTrades = 500;
    e.paperSessions = 50;
    e.paperExpectancyPositive = true;
    e.paperDrawdownWithinLimit = true;
    e.riskGatePass = true;
    e.brokerHealthPass = true;
    e.marketDataHealthPass = true;
    e.startupHealthPass = true;
    e.manualLiveApproval = true;
    expect(deriveLifecycleStatus(e)).toBe('UNTESTED');
  });

  it('warns on large parameter search', () => {
    const w = multipleTestingWarning(researchSafety.multipleTestingWarnAboveTrials + 1);
    expect(w.warning).toBe(true);
    expect(w.note).toContain('MULTIPLE_TESTING_RISK');
  });

  it('Kelly is research-only and UNAVAILABLE below sample floor', () => {
    const k = researchKelly(0.6, 2, 3);
    expect(k.label).toBe('KELLY_UNAVAILABLE');
    expect(k.usedByRiskEngine).toBe(false);
  });

  it('comparison matrix does not invent PASS', () => {
    const m = researchComparisonMatrix();
    expect(m.rows.every((r) => r.final === 'UNTESTED' || r.strategy === 'SMC_LIQUIDITY_SWEEP')).toBe(true);
    expect(m.rows.every((r) => r.backtest === 'UNTESTED' && r.invented === false)).toBe(true);
  });

  it('default execution model is NEXT_BAR_OPEN', () => {
    expect(getExecutionModel().executionModel).toBe('NEXT_BAR_OPEN');
  });

  it('dataset hash includes adjustment policy', () => {
    const ds = loadGoldenSmaDataset();
    const h1 = hashCanonicalDataset(ds);
    const h2 = hashCanonicalDataset({ ...ds, adjustmentPolicy: 'SPLIT_ADJUSTED' });
    expect(h1).not.toBe(h2);
  });
});
