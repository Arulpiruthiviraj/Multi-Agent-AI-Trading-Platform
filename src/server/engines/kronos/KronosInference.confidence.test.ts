import { describe, it, expect } from 'vitest';
import { computeKronosConfidence } from './KronosInference';
import { quantThresholds } from '../../config/quantThresholds';

// Real, measured 2026-09-04 distribution from a 3,000-row live sample of kronos_predictions.volatility
// (relativeSpread as a percentage). Before this recalibration, confidence read exactly the 0.85 ceiling
// on 2,999/3,000 of those rows - see KronosInference.ts's computeKronosConfidence() doc comment.
const MEASURED_RELATIVE_SPREAD = {
  p50: 0,
  p90: 0.0073,
  p99: 0.0224,
};

describe('computeKronosConfidence', () => {
  it('saturates the ceiling for a genuinely zero-width quantile band', () => {
    expect(computeKronosConfidence(MEASURED_RELATIVE_SPREAD.p50)).toBe(quantThresholds.kronosConfidenceCeiling);
  });

  it('no longer saturates the ceiling at the real measured p90 spread (the pre-fix defect)', () => {
    const conf = computeKronosConfidence(MEASURED_RELATIVE_SPREAD.p90);
    expect(conf).toBeLessThan(quantThresholds.kronosConfidenceCeiling);
    expect(conf).toBeGreaterThan(0.75);
  });

  it('pulls meaningfully toward the floor at the real measured p99 spread', () => {
    const conf = computeKronosConfidence(MEASURED_RELATIVE_SPREAD.p99);
    expect(conf).toBeLessThan(0.5);
    expect(conf).toBeGreaterThan(quantThresholds.kronosConfidenceFloor);
  });

  it('never goes below the configured floor for an extreme spread', () => {
    expect(computeKronosConfidence(1)).toBe(quantThresholds.kronosConfidenceFloor);
  });

  it('never exceeds the configured ceiling for a negative/degenerate spread input', () => {
    expect(computeKronosConfidence(-1)).toBe(quantThresholds.kronosConfidenceCeiling);
  });
});
