import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordExperimentTrial,
  experimentLedgerSnapshot,
  experimentAuditTrail,
  calculateDeflatedSharpeRatio,
  deflatedSharpeRatioFromLedger,
} from './experimentLedger';

describe('experimentLedger - per-trial provenance', () => {
  it('recordExperimentTrial keeps its original 2-argument call working unchanged (backward compatible)', () => {
    const before = experimentLedgerSnapshot().trials;
    const result = recordExperimentTrial('MOMENTUM_BREAKOUT', 'hash-legacy-call');
    expect(result.trials).toBe(before + 1);
    const [latest] = experimentAuditTrail('MOMENTUM_BREAKOUT').slice(-1);
    expect(latest.selectionStatus).toBe('ACCEPTED'); // default, matching the real pre-existing semantics
    expect(latest.parameterSet).toBeNull();
  });

  it('records full per-trial detail when supplied, including rejected/pruned trials', () => {
    recordExperimentTrial('MEAN_REVERSION', 'hash-a', {
      parameterSet: { lookback: 20, zScore: 2 },
      inSampleMetrics: { sharpe: 1.2 },
      outOfSampleMetrics: { sharpe: -0.3 },
      rejectionReason: 'Negative OOS Sharpe',
      selectionStatus: 'REJECTED',
    });
    const trials = experimentAuditTrail('MEAN_REVERSION');
    const rejected = trials.find(t => t.rejectionReason === 'Negative OOS Sharpe');
    expect(rejected).toBeDefined();
    expect(rejected!.selectionStatus).toBe('REJECTED');
    expect(rejected!.parameterSet).toEqual({ lookback: 20, zScore: 2 });
  });

  it('experimentAuditTrail(strategyId) never leaks another strategy\'s trials', () => {
    recordExperimentTrial('RANGE_REVERSION', 'hash-b', { selectionStatus: 'OVERFIT_PRUNED', rejectionReason: 'parameter unstable across folds' });
    const rangeReversionTrials = experimentAuditTrail('RANGE_REVERSION');
    expect(rangeReversionTrials.every(t => t.strategyId === 'RANGE_REVERSION')).toBe(true);
  });
});

describe('calculateDeflatedSharpeRatio - Bailey & Lopez de Prado DSR', () => {
  it('refuses to compute with fewer than 2 trials (never fabricates a DSR from a single result)', () => {
    const r = calculateDeflatedSharpeRatio({ observedSharpe: 2.0, numTrials: 1, sharpeStdDev: 0.5, numObservations: 100 });
    expect(r.deflatedSharpeRatio).toBe(0);
    expect(r.note).toContain('INSUFFICIENT_TRIALS');
  });

  it('refuses to compute with zero/negative cross-trial Sharpe variance', () => {
    const r = calculateDeflatedSharpeRatio({ observedSharpe: 2.0, numTrials: 50, sharpeStdDev: 0, numObservations: 100 });
    expect(r.deflatedSharpeRatio).toBe(0);
    expect(r.note).toContain('DEGENERATE_VARIANCE');
  });

  it('refuses to compute with an insufficient observation count', () => {
    const r = calculateDeflatedSharpeRatio({ observedSharpe: 2.0, numTrials: 50, sharpeStdDev: 0.4, numObservations: 1 });
    expect(r.deflatedSharpeRatio).toBe(0);
    expect(r.note).toContain('INSUFFICIENT_SAMPLE');
  });

  it('returns exactly 0.5 when the observed Sharpe exactly equals the expected max under the null (z=0)', () => {
    // Real, checkable property: normalCdf(0) = 0.5 exactly, independent of the specific
    // trial-count/variance inputs, as long as observedSharpe === expectedMaxSharpeUnderNull.
    const probe = calculateDeflatedSharpeRatio({ observedSharpe: 0, numTrials: 30, sharpeStdDev: 0.4, numObservations: 200 });
    const r = calculateDeflatedSharpeRatio({
      observedSharpe: probe.expectedMaxSharpeUnderNull, numTrials: 30, sharpeStdDev: 0.4, numObservations: 200,
    });
    expect(r.deflatedSharpeRatio).toBeCloseTo(0.5, 6);
  });

  it('a real Sharpe far above the expected max under the null produces a high DSR (close to 1)', () => {
    const r = calculateDeflatedSharpeRatio({ observedSharpe: 5.0, numTrials: 30, sharpeStdDev: 0.4, numObservations: 500 });
    expect(r.deflatedSharpeRatio).toBeGreaterThan(0.99);
  });

  it('a real Sharpe far below the expected max under the null produces a low DSR (close to 0)', () => {
    const r = calculateDeflatedSharpeRatio({ observedSharpe: -5.0, numTrials: 30, sharpeStdDev: 0.4, numObservations: 500 });
    expect(r.deflatedSharpeRatio).toBeLessThan(0.01);
  });

  it('deflatedSharpeRatio is always a real probability in [0,1] across a range of realistic inputs', () => {
    for (const trials of [2, 5, 25, 100]) {
      for (const sharpe of [-1, 0, 0.5, 1, 2, 3]) {
        const r = calculateDeflatedSharpeRatio({ observedSharpe: sharpe, numTrials: trials, sharpeStdDev: 0.3, numObservations: 252 });
        expect(r.deflatedSharpeRatio).toBeGreaterThanOrEqual(0);
        expect(r.deflatedSharpeRatio).toBeLessThanOrEqual(1);
      }
    }
  });

  it('more trials raise the expected-max-under-null bar, making the same observed Sharpe less impressive (real overfitting penalty)', () => {
    const few = calculateDeflatedSharpeRatio({ observedSharpe: 1.5, numTrials: 5, sharpeStdDev: 0.4, numObservations: 252 });
    const many = calculateDeflatedSharpeRatio({ observedSharpe: 1.5, numTrials: 500, sharpeStdDev: 0.4, numObservations: 252 });
    expect(many.expectedMaxSharpeUnderNull).toBeGreaterThan(few.expectedMaxSharpeUnderNull);
    expect(many.deflatedSharpeRatio).toBeLessThan(few.deflatedSharpeRatio);
  });
});

describe('deflatedSharpeRatioFromLedger', () => {
  it('returns null (never fabricated) when fewer than 2 recorded trials carry a real numeric OOS Sharpe', () => {
    const r = deflatedSharpeRatioFromLedger('STRATEGY_WITH_NO_REAL_TRIALS_' + Date.now(), 252);
    expect(r).toBeNull();
  });

  it('computes a real DSR from real recorded trial Sharpe ratios once at least 2 exist', () => {
    const strategyId = 'TEST_DSR_STRATEGY_' + Date.now();
    recordExperimentTrial(strategyId, 'hash-1', { outOfSampleMetrics: { sharpe: 0.8 }, selectionStatus: 'REJECTED' });
    recordExperimentTrial(strategyId, 'hash-2', { outOfSampleMetrics: { sharpe: 1.9 }, selectionStatus: 'ACCEPTED' });
    recordExperimentTrial(strategyId, 'hash-3', { outOfSampleMetrics: { sharpe: 1.1 }, selectionStatus: 'REJECTED' });
    const r = deflatedSharpeRatioFromLedger(strategyId, 252);
    expect(r).not.toBeNull();
    expect(r!.deflatedSharpeRatio).toBeGreaterThanOrEqual(0);
    expect(r!.deflatedSharpeRatio).toBeLessThanOrEqual(1);
  });
});
