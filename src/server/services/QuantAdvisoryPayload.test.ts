import { describe, it, expect } from 'vitest';
import { buildQuantAdvisoryPayload } from './QuantAdvisoryPayload';
import type { InstitutionalAdvisoryResult } from './QuantCoreBridge';

describe('buildQuantAdvisoryPayload', () => {
  const fakeAdvisory: InstitutionalAdvisoryResult = {
    schemaVersion: 1,
    rawSide: 'BUY',
    rawAvgConfidence: 0.8,
    rawEffectiveIndependentCount: 1,
    regime: 'BULL_TRENDING',
    regimeMultiplier: 1,
    currentVolatility: 0.015,
    volatilityMultiplier: 1,
    adjustedConfidence: 0.8,
    gated: false,
    reasoning: 'x',
    agreeingModelIds: ['factor'],
    dissentingModelIds: [],
  };

  it('always tags executionEnvironment as the literal ADVISORY_ONLY, not a passthrough field', () => {
    const payload = buildQuantAdvisoryPayload('AAPL', fakeAdvisory);
    expect(payload.executionEnvironment).toBe('ADVISORY_ONLY');
  });

  it('carries every field from the Java result through unchanged', () => {
    const payload = buildQuantAdvisoryPayload('AAPL', fakeAdvisory, '2026-08-24T12:00:00.000Z');
    expect(payload).toEqual({
      schemaVersion: 1,
      executionEnvironment: 'ADVISORY_ONLY',
      symbol: 'AAPL',
      timestamp: '2026-08-24T12:00:00.000Z',
      rawSide: 'BUY',
      rawAvgConfidence: 0.8,
      rawEffectiveIndependentCount: 1,
      regime: 'BULL_TRENDING',
      regimeMultiplier: 1,
      currentVolatility: 0.015,
      volatilityMultiplier: 1,
      adjustedConfidence: 0.8,
      gated: false,
      reasoning: 'x',
      agreeingModelIds: ['factor'],
      dissentingModelIds: [],
    });
  });

  it('defaults timestamp to now when not supplied', () => {
    const before = Date.now();
    const payload = buildQuantAdvisoryPayload('AAPL', fakeAdvisory);
    const after = Date.now();
    const ts = new Date(payload.timestamp).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
