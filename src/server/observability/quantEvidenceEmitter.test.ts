import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  emitQuantEvidenceObservability,
  validateQuantEvidenceForEmission,
} from './quantEvidenceEmitter';
import {
  setObservabilityPersistForTests,
  resetObservabilityStoreForTests,
  flushObservabilityStore,
  type ObservabilityEventRow,
} from './ObservabilityStore';
import { mapJavaCoreEnsembleToQuantEvidence, mapJavaFactorCompositeToQuantEvidence } from '../quant/quantEvidenceAdapters';
import type { CoreEnsembleDecision } from '../services/QuantCoreBridge';
import type { QuantAdvisoryPayload } from '../services/QuantAdvisoryPayload';
import type { QuantEvidence } from '../quant/QuantEvidence';

function baseEnsemble(overrides: Partial<CoreEnsembleDecision> = {}): CoreEnsembleDecision {
  return {
    schemaVersion: 1,
    status: 'HEALTHY',
    direction: 'BUY',
    score: 0.7,
    confidence: 0.65,
    reason: 'RangeReversion+TrendFollowing agree',
    regime: 'TRENDING',
    timestampMs: Date.now(),
    featureVersion: 'v1',
    strategyVersion: 'v1',
    strategyCount: 5,
    agreeingCount: 2,
    effectiveIndependentCount: 1.8,
    contributingStrategies: ['RANGE_REVERSION', 'TREND_FOLLOWING'],
    contributingFamilies: ['reversion', 'trend'],
    ...overrides,
  } as CoreEnsembleDecision;
}

function baseAdvisory(overrides: Partial<QuantAdvisoryPayload> = {}): QuantAdvisoryPayload {
  return {
    schemaVersion: 1,
    executionEnvironment: 'ADVISORY_ONLY',
    symbol: 'AAPL',
    timestamp: new Date().toISOString(),
    rawSide: 'BUY',
    rawAvgConfidence: 0.7,
    rawEffectiveIndependentCount: 1,
    regime: 'BULL_TRENDING',
    regimeMultiplier: 1.0,
    currentVolatility: 0.02,
    volatilityMultiplier: 0.9,
    adjustedConfidence: 0.65,
    gated: false,
    reasoning: 'trend-aligned BUY',
    agreeingModelIds: ['factor_composite'],
    dissentingModelIds: [],
    ...overrides,
  } as QuantAdvisoryPayload;
}

describe('validateQuantEvidenceForEmission', () => {
  it('accepts a real, well-formed QuantEvidence object from each real adapter', () => {
    expect(validateQuantEvidenceForEmission(mapJavaCoreEnsembleToQuantEvidence(baseEnsemble())).valid).toBe(true);
    expect(validateQuantEvidenceForEmission(mapJavaFactorCompositeToQuantEvidence(baseAdvisory())).valid).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects a numeric field whose value is %s',
    (bad) => {
      const evidence = mapJavaCoreEnsembleToQuantEvidence(baseEnsemble());
      const poisoned: QuantEvidence = { ...evidence, rawScore: { value: bad, provenance: 'REAL_VALUE' } };
      const result = validateQuantEvidenceForEmission(poisoned);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('rawScore');
    },
  );

  it('rejects a 5th, invented provenance label', () => {
    const evidence = mapJavaCoreEnsembleToQuantEvidence(baseEnsemble());
    const poisoned = { ...evidence, confidence: { value: 0.5, provenance: 'ESTIMATED' } } as unknown as QuantEvidence;
    expect(validateQuantEvidenceForEmission(poisoned).valid).toBe(false);
  });

  it('rejects a confidence value outside [0,1]', () => {
    const evidence = mapJavaCoreEnsembleToQuantEvidence(baseEnsemble());
    const poisoned: QuantEvidence = { ...evidence, confidence: { value: 1.5, provenance: 'REAL_VALUE' } };
    expect(validateQuantEvidenceForEmission(poisoned).valid).toBe(false);
  });

  it('rejects probabilities that do not sum sanely to 1', () => {
    const evidence = mapJavaCoreEnsembleToQuantEvidence(baseEnsemble());
    const poisoned: QuantEvidence = {
      ...evidence,
      probabilityUp: { value: 0.9, provenance: 'DERIVED' },
      probabilityDown: { value: 0.9, provenance: 'DERIVED' },
      probabilityFlat: { value: 0.9, provenance: 'DERIVED' },
    };
    expect(validateQuantEvidenceForEmission(poisoned).valid).toBe(false);
  });

  it('rejects an invalid direction', () => {
    const evidence = mapJavaCoreEnsembleToQuantEvidence(baseEnsemble());
    const poisoned = { ...evidence, direction: 'STRONG_BUY' } as unknown as QuantEvidence;
    expect(validateQuantEvidenceForEmission(poisoned).valid).toBe(false);
  });
});

describe('emitQuantEvidenceObservability', () => {
  let captured: ObservabilityEventRow[];

  beforeEach(() => {
    captured = [];
    resetObservabilityStoreForTests();
    setObservabilityPersistForTests(async (batch) => { captured.push(...batch); });
  });

  afterEach(async () => {
    await flushObservabilityStore();
    setObservabilityPersistForTests(null);
    resetObservabilityStoreForTests();
  });

  it('emits a real QUANT_EVIDENCE_PRODUCED row with the symbol, producer and full evidence payload', async () => {
    emitQuantEvidenceObservability('AAPL', mapJavaCoreEnsembleToQuantEvidence(baseEnsemble()));
    await flushObservabilityStore();

    const row = captured.find((r) => r.eventType === 'QUANT_EVIDENCE_PRODUCED');
    expect(row).toBeDefined();
    expect(row!.symbol).toBe('AAPL');
    expect(row!.level).toBe('INFO');
    const payload = JSON.parse(row!.payload as string);
    expect(payload.producer).toBe('JavaCoreEnsemble');
  });

  it('never throws and suppresses emission on invalid input, logging QUANT_EVIDENCE_VALIDATION_FAILED instead', async () => {
    const evidence = mapJavaFactorCompositeToQuantEvidence(baseAdvisory());
    const poisoned = { ...evidence, confidence: { value: Number.NaN, provenance: 'REAL_VALUE' } } as unknown as QuantEvidence;
    expect(() => emitQuantEvidenceObservability('AAPL', poisoned)).not.toThrow();
    await flushObservabilityStore();

    expect(captured.find((r) => r.eventType === 'QUANT_EVIDENCE_PRODUCED')).toBeUndefined();
    const warnRow = captured.find((r) => r.eventType === 'QUANT_EVIDENCE_VALIDATION_FAILED');
    expect(warnRow).toBeDefined();
    expect(warnRow!.level).toBe('WARN');
  });

  it('never throws even with a completely malformed (non-object) input', () => {
    expect(() => emitQuantEvidenceObservability('AAPL', null as unknown as QuantEvidence)).not.toThrow();
    expect(() => emitQuantEvidenceObservability('AAPL', undefined as unknown as QuantEvidence)).not.toThrow();
  });
});
