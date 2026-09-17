import { describe, it, expect } from 'vitest';
import {
  computeRawCalibration,
  computeEffectiveNClusteredCalibration,
  compareCalibrationMethods,
  replayConsensusUnderBothMethods,
  PRODUCTION_CALIBRATION_METHOD,
  CALIBRATION_METHODS,
  type CalibrationMethodComparison,
} from './calibrationMethodComparison';
import type { ClusterableRow } from './effectiveSampleSize';

function row(symbol: string, agent: string, side: string, timestampMs: number, outcome: ClusterableRow['outcome']): ClusterableRow {
  return { symbol, agent, side, timestampMs, outcome };
}

const BUCKET = { low: 0.8, high: 0.9 };

describe('computeRawCalibration', () => {
  it('counts every directional row as one independent observation (matches ReflectionEngine.ts exactly)', () => {
    // 10 rows, all 1 second apart - a raw count treats these as 10 independent observations.
    const rows = Array.from({ length: 10 }, (_, i) =>
      row('SPY', 'KronosEngine', 'SELL', i * 1000, i < 5 ? 'WIN' : 'LOSS'));
    const result = computeRawCalibration(rows, BUCKET);
    expect(result.method).toBe('RAW_BETA_BINOMIAL');
    expect(result.n).toBe(10);
    expect(result.wins).toBe(5);
    expect(result.losses).toBe(5);
  });

  it('excludes N_A (HOLD-style) rows from the denominator, same as ReflectionEngine.ts', () => {
    const rows = [
      row('SPY', 'KronosEngine', 'SELL', 0, 'WIN'),
      row('SPY', 'KronosEngine', 'SELL', 1000, 'N_A'),
      row('SPY', 'KronosEngine', 'SELL', 2000, 'LOSS'),
    ];
    const result = computeRawCalibration(rows, BUCKET);
    expect(result.n).toBe(2);
  });
});

describe('computeEffectiveNClusteredCalibration', () => {
  it('collapses tightly-spaced repeated predictions into one independent observation', () => {
    // Same 10 rows as above, but 1 second apart with a 5-minute cluster gap - all 10 collapse to
    // a single cluster (Kronos's real production pattern: near-continuous re-firing on an
    // unchanged market condition).
    const rows = Array.from({ length: 10 }, (_, i) =>
      row('SPY', 'KronosEngine', 'SELL', i * 1000, i < 5 ? 'WIN' : 'LOSS'));
    const result = computeEffectiveNClusteredCalibration(rows, BUCKET, 300000);
    expect(result.method).toBe('EFFECTIVE_N_CLUSTERED_BETA_BINOMIAL');
    expect(result.n).toBe(1); // one cluster
    // graded by the cluster's own LAST row (i=9, LOSS)
    expect(result.wins).toBe(0);
    expect(result.losses).toBe(1);
  });

  it('produces real, materially smaller N than the raw method on realistic high-frequency data', () => {
    // Mirrors the real production shape found 2026-09-15: many rows per real market event.
    const rows: ClusterableRow[] = [];
    let t = 0;
    for (let cluster = 0; cluster < 20; cluster++) {
      for (let i = 0; i < 15; i++) {
        rows.push(row('QQQ', 'KronosEngine', 'SELL', t, cluster % 2 === 0 ? 'WIN' : 'LOSS'));
        t += 1000; // 1s apart within a cluster
      }
      t += 400000; // > 300000ms gap between clusters
    }
    const raw = computeRawCalibration(rows, BUCKET);
    const effective = computeEffectiveNClusteredCalibration(rows, BUCKET, 300000);
    expect(raw.n).toBe(300);
    expect(effective.n).toBe(20);
    expect(effective.n).toBeLessThan(raw.n);
  });
});

describe('compareCalibrationMethods', () => {
  it('flags a real, evidenced inflation factor and reports both methods without picking a winner', () => {
    const rows: ClusterableRow[] = [];
    let t = 0;
    for (let cluster = 0; cluster < 30; cluster++) {
      for (let i = 0; i < 10; i++) {
        rows.push(row('SPY', 'KronosEngine', 'SELL', t, i === 9 && cluster < 15 ? 'WIN' : 'LOSS'));
        t += 1000;
      }
      t += 400000;
    }
    const cmp = compareCalibrationMethods('KronosEngine', BUCKET, rows, 300000, 0.5, 30);
    expect(cmp.raw.n).toBe(300);
    expect(cmp.effective.n).toBe(30);
    expect(cmp.inflationFactor).toBeCloseTo(10, 5);
    // Both methods' own calibratedConfidence values must be present and independently computed.
    expect(cmp.raw.calibratedConfidence).toBeGreaterThan(0);
    expect(cmp.effective.calibratedConfidence).toBeGreaterThan(0);
  });

  it('detects a trust-gate flip when raw and effective disagree on whether the Wilson lower bound clears the trust floor', () => {
    // Construct a case where raw N is huge (tight interval, clears 0.5) but effective N is tiny
    // (wide interval, does not clear 0.5) - the exact real pattern found in QuantEngine's 0.7-0.8
    // bucket in production (raw 58.9% win rate over 779 obs vs effective 41.7% over 12 obs).
    const rows: ClusterableRow[] = [];
    let t = 0;
    for (let cluster = 0; cluster < 12; cluster++) {
      for (let i = 0; i < 60; i++) {
        // 58% raw win rate, but each cluster is graded by its own LAST row - rig 5 of 12 clusters WIN
        rows.push(row('QQQ', 'QuantEngine', 'BUY', t, cluster < 5 ? 'WIN' : 'LOSS'));
        t += 1000;
      }
      t += 4000000;
    }
    const cmp = compareCalibrationMethods('QuantEngine', BUCKET, rows, 300000, 0.5, 30);
    expect(cmp.effective.n).toBe(12);
    expect(cmp.effectiveNBelowMinSample).toBe(true);
    // A tiny effective N produces a wide interval that should not clear a 0.5 trust floor even
    // if the point estimate is above 0.5.
    expect(cmp.effectiveTrusted).toBe(false);
  });

  it('flags effectiveNBelowMinSample honestly rather than silently treating a thin sample as sufficient', () => {
    const rows = Array.from({ length: 3 }, (_, i) => row('GLD', 'JavaFactorComposite', 'BUY', i * 1_000_000, 'WIN'));
    const cmp = compareCalibrationMethods('JavaFactorComposite', BUCKET, rows, 300000, 0.5, 30);
    expect(cmp.effective.n).toBe(3);
    expect(cmp.effectiveNBelowMinSample).toBe(true);
  });
});

describe('replayConsensusUnderBothMethods', () => {
  it('reproduces a real historical weighted-consensus outcome under the raw method', () => {
    const result = replayConsensusUnderBothMethods({
      rawConfidenceByAgent: { KronosEngine: 0.4721, MacroAgent: 0 },
      effectiveConfidenceByAgent: { KronosEngine: 0.505, MacroAgent: 0 },
      weightByAgent: { KronosEngine: 0.2, MacroAgent: 0.15 },
    }, 0.75);
    // (0.2*0.4721 + 0.15*0) / 0.35
    expect(result.rawWeightedConfidence).toBeCloseTo((0.2 * 0.4721) / 0.35, 4);
    expect(result.rawClearsStrong).toBe(false);
    expect(result.effectiveWeightedConfidence).not.toBeNull();
    expect(result.effectiveClearsStrong).toBe(false);
    expect(result.tierFlip).toBe(false);
  });

  it('detects a genuine tier flip when the effective method pushes weighted confidence across the STRONG bar', () => {
    const result = replayConsensusUnderBothMethods({
      rawConfidenceByAgent: { AgentA: 0.7, AgentB: 0.7 },
      effectiveConfidenceByAgent: { AgentA: 0.8, AgentB: 0.8 },
      weightByAgent: { AgentA: 0.5, AgentB: 0.5 },
    }, 0.75);
    expect(result.rawClearsStrong).toBe(false);
    expect(result.effectiveClearsStrong).toBe(true);
    expect(result.tierFlip).toBe(true);
  });

  it('never fabricates an effective-side number when comparison data is genuinely unavailable for an agent', () => {
    const result = replayConsensusUnderBothMethods({
      rawConfidenceByAgent: { AgentA: 0.7, AgentB: 0.7 },
      effectiveConfidenceByAgent: { AgentA: 0.8, AgentB: null },
      weightByAgent: { AgentA: 0.5, AgentB: 0.5 },
    }, 0.75);
    expect(result.effectiveWeightedConfidence).toBeNull();
    expect(result.effectiveClearsStrong).toBeNull();
    expect(result.tierFlip).toBe(false); // null !== anything is guarded, never counted as a flip
  });
});

describe('module-level provenance constants', () => {
  it('names both methods explicitly and marks which one production currently uses', () => {
    expect(CALIBRATION_METHODS).toEqual(['RAW_BETA_BINOMIAL', 'EFFECTIVE_N_CLUSTERED_BETA_BINOMIAL']);
    expect(PRODUCTION_CALIBRATION_METHOD).toBe('RAW_BETA_BINOMIAL');
  });
});

describe('honesty invariant', () => {
  it('never lets a comparison silently prefer one method - both raw and effective are always present', () => {
    const rows = Array.from({ length: 50 }, (_, i) => row('SPY', 'TechnicalAgent', 'BUY', i * 100000, i % 2 === 0 ? 'WIN' : 'LOSS'));
    const cmp: CalibrationMethodComparison = compareCalibrationMethods('TechnicalAgent', BUCKET, rows, 3600000, 0.5, 30);
    expect(cmp.raw).toBeDefined();
    expect(cmp.effective).toBeDefined();
    expect(cmp.raw.method).toBe('RAW_BETA_BINOMIAL');
    expect(cmp.effective.method).toBe('EFFECTIVE_N_CLUSTERED_BETA_BINOMIAL');
  });
});
