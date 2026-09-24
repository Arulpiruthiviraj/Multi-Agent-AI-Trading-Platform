import { describe, it, expect } from 'vitest';
import type { InstitutionalAdvisoryResult, CoreEnsembleDecision } from '../services/QuantCoreBridge';
import type { QuantAdvisoryPayload } from '../services/QuantAdvisoryPayload';
import {
  mapJavaFactorCompositeToQuantEvidence,
  mapJavaCoreEnsembleToQuantEvidence,
} from './quantEvidenceAdapters';
import type { FieldProvenance, QuantEvidence } from './QuantEvidence';

/** Realistic fixture matching InstitutionalAdvisoryResult's real field set from QuantCoreBridge.ts. */
function makeAdvisoryFixture(overrides: Partial<InstitutionalAdvisoryResult> = {}): InstitutionalAdvisoryResult {
  return {
    schemaVersion: 1,
    rawSide: 'BUY',
    rawAvgConfidence: 0.62,
    rawEffectiveIndependentCount: 1,
    regime: 'BULL_TRENDING',
    regimeMultiplier: 1.1,
    currentVolatility: 0.18,
    volatilityMultiplier: 0.95,
    adjustedConfidence: 0.648,
    gated: false,
    reasoning: 'Factor composite positive, regime bullish, volatility normal.',
    agreeingModelIds: ['factor_composite'],
    dissentingModelIds: [],
    ...overrides,
  };
}

function makeAdvisoryPayloadFixture(overrides: Partial<QuantAdvisoryPayload> = {}): QuantAdvisoryPayload {
  return {
    schemaVersion: 1,
    executionEnvironment: 'ADVISORY_ONLY',
    symbol: 'AAPL',
    timestamp: new Date().toISOString(),
    rawSide: 'BUY',
    rawAvgConfidence: 0.62,
    rawEffectiveIndependentCount: 1,
    regime: 'BULL_TRENDING',
    regimeMultiplier: 1.1,
    currentVolatility: 0.18,
    volatilityMultiplier: 0.95,
    adjustedConfidence: 0.648,
    gated: false,
    reasoning: 'Factor composite positive, regime bullish, volatility normal.',
    agreeingModelIds: ['factor_composite'],
    dissentingModelIds: [],
    ...overrides,
  };
}

/** Realistic fixture matching CoreEnsembleDecision's real field set from QuantCoreBridge.ts. */
function makeCoreEnsembleFixture(overrides: Partial<CoreEnsembleDecision> = {}): CoreEnsembleDecision {
  return {
    schemaVersion: 1,
    status: 'HEALTHY',
    direction: 'BUY',
    score: 0.71,
    confidence: 0.66,
    reason: '4/5 CORE strategies agree BUY',
    regime: 'TRENDING',
    timestampMs: Date.now(),
    featureVersion: 'v3',
    strategyVersion: 'v2',
    strategyCount: 5,
    agreeingCount: 4,
    effectiveIndependentCount: 2.8,
    contributingStrategies: ['MOMENTUM_BREAKOUT', 'TREND_FOLLOWING', 'PULLBACK_CONTINUATION', 'RANGE_REVERSION'],
    contributingFamilies: ['MOMENTUM', 'TREND', 'MEAN_REVERSION'],
    assessments: [],
    ...overrides,
  };
}

const NULL_FIELDS: (keyof QuantEvidence)[] = [
  'predictedReturn',
  'predictedVolatility',
  'downsideRisk',
  'upsidePotential',
  'probabilityUp',
  'probabilityDown',
  'probabilityFlat',
  'uncertainty',
  'estimatedTransactionCostBps',
  'netExpectedReturn',
];

function expectAllNull(evidence: QuantEvidence, fields: (keyof QuantEvidence)[]) {
  for (const f of fields) {
    const field = evidence[f] as { value: unknown; provenance: FieldProvenance };
    expect(field.value, `${f} should be null`).toBeNull();
    expect(['NULL_NOT_SUPPORTED', 'NOT_YET_CALIBRATED']).toContain(field.provenance);
  }
}

describe('mapJavaFactorCompositeToQuantEvidence', () => {
  it('maps real fields from InstitutionalAdvisoryResult as REAL_VALUE', () => {
    const advisory = makeAdvisoryFixture();
    const evidence = mapJavaFactorCompositeToQuantEvidence(advisory);

    expect(evidence.producer).toBe('JavaFactorComposite');
    expect(evidence.direction).toBe('BUY');
    expect(evidence.methodologyFamily).toBe('FACTOR_MODEL');

    expect(evidence.rawScore).toEqual({ value: 0.62, provenance: 'REAL_VALUE' });
    expect(evidence.confidence).toEqual({ value: 0.648, provenance: 'REAL_VALUE' });
    expect(evidence.regime).toEqual({ value: 'BULL_TRENDING', provenance: 'REAL_VALUE' });
  });

  it('never fabricates unsupported fields — all are null with an honest provenance label', () => {
    const evidence = mapJavaFactorCompositeToQuantEvidence(makeAdvisoryFixture());
    expectAllNull(evidence, NULL_FIELDS);
    expect(evidence.normalizedScore.value).toBeNull();
    expect(evidence.normalizedScore.provenance).toBe('NULL_NOT_SUPPORTED');
    expect(evidence.dataFreshness.value).toBeNull();
    expect(evidence.inputCompleteness.value).toBeNull();
    expect(evidence.costQuality).toBe('NOT_APPLICABLE');
    expect(evidence.netReturnAvailable).toBe(false);
    expect(evidence.calibrationStatus).toBe('NOT_YET_CALIBRATED');
  });

  it('accepts the QuantAdvisoryPayload wrapper shape identically to the raw bridge result', () => {
    const evidence = mapJavaFactorCompositeToQuantEvidence(makeAdvisoryPayloadFixture());
    expect(evidence.rawScore.value).toBe(0.62);
    expect(evidence.confidence.value).toBe(0.648);
  });

  it('maps NEUTRAL side to HOLD direction without fabricating a BUY/SELL call', () => {
    const evidence = mapJavaFactorCompositeToQuantEvidence(makeAdvisoryFixture({ rawSide: 'NEUTRAL' }));
    expect(evidence.direction).toBe('HOLD');
  });
});

describe('mapJavaCoreEnsembleToQuantEvidence', () => {
  it('maps real fields from CoreEnsembleDecision as REAL_VALUE', () => {
    const decision = makeCoreEnsembleFixture();
    const evidence = mapJavaCoreEnsembleToQuantEvidence(decision);

    expect(evidence.producer).toBe('JavaCoreEnsemble');
    expect(evidence.direction).toBe('BUY');
    expect(evidence.methodologyFamily).toBe('TECHNICAL_ENSEMBLE');
    expect(evidence.rawScore).toEqual({ value: 0.71, provenance: 'REAL_VALUE' });
    expect(evidence.confidence).toEqual({ value: 0.66, provenance: 'REAL_VALUE' });
    expect(evidence.regime).toEqual({ value: 'TRENDING', provenance: 'REAL_VALUE' });
  });

  it('derives normalizedScore and inputCompleteness as real deterministic ratios, labeled DERIVED', () => {
    const evidence = mapJavaCoreEnsembleToQuantEvidence(makeCoreEnsembleFixture());
    expect(evidence.normalizedScore).toEqual({ value: 2.8 / 5, provenance: 'DERIVED' });
    expect(evidence.inputCompleteness).toEqual({ value: 4 / 5, provenance: 'DERIVED' });
  });

  it('guards the derived ratios against divide-by-zero instead of fabricating a value', () => {
    const evidence = mapJavaCoreEnsembleToQuantEvidence(makeCoreEnsembleFixture({ strategyCount: 0, agreeingCount: 0 }));
    expect(evidence.normalizedScore).toEqual({ value: null, provenance: 'NULL_NOT_SUPPORTED' });
    expect(evidence.inputCompleteness).toEqual({ value: null, provenance: 'NULL_NOT_SUPPORTED' });
  });

  it('reports regime as NULL_NOT_SUPPORTED (not a fabricated string) when Java itself returns null', () => {
    const evidence = mapJavaCoreEnsembleToQuantEvidence(makeCoreEnsembleFixture({ regime: null }));
    expect(evidence.regime).toEqual({ value: null, provenance: 'NULL_NOT_SUPPORTED' });
  });

  it('never fabricates unsupported fields — all are null with an honest provenance label', () => {
    const evidence = mapJavaCoreEnsembleToQuantEvidence(makeCoreEnsembleFixture());
    expectAllNull(evidence, NULL_FIELDS);
    expect(evidence.dataFreshness.value).toBeNull();
    expect(evidence.costQuality).toBe('NOT_APPLICABLE');
    expect(evidence.netReturnAvailable).toBe(false);
    expect(evidence.calibrationStatus).toBe('NOT_YET_CALIBRATED');
  });

  it('maps HOLD direction straight through without alteration', () => {
    const evidence = mapJavaCoreEnsembleToQuantEvidence(makeCoreEnsembleFixture({ direction: 'HOLD' }));
    expect(evidence.direction).toBe('HOLD');
  });
});
