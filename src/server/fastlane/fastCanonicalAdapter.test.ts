import { describe, it, expect } from 'vitest';
import { convertFastEvaluationToCanonicalIdea, computeEvidenceFingerprint } from './fastCanonicalAdapter';
import type { FastEvaluationResult, FastOpportunityCandidate } from './FastOpportunityCandidate';

function fakeCandidate(overrides: Partial<FastOpportunityCandidate> = {}): FastOpportunityCandidate {
  const now = Date.now();
  return {
    id: 'cand-1',
    symbol: 'AAPL',
    detectedAt: now,
    expiresAt: now + 60 * 60_000,
    lastEvidenceAt: now,
    detectionSource: 'NEWS_CATALYST',
    catalyst: 'test catalyst',
    liquidityEvidence: { dollarVolume: null, spreadBps: null, meetsMinLiquidity: false },
    requiredDataTier: 'TIER_1',
    currentDataTier: 'TIER_0',
    applicableStrategies: [],
    state: 'ACTIONABLE',
    stateHistory: [],
    ...overrides,
  };
}

function fakeResult(overrides: Partial<FastEvaluationResult> = {}): FastEvaluationResult {
  const now = Date.now();
  return {
    id: 'cand-1:123',
    candidateId: 'cand-1',
    symbol: 'AAPL',
    evaluatedAt: now,
    dataAsOf: now,
    marketDataType: 'CACHED_BARS',
    strategiesEvaluated: ['MOMENTUM_BREAKOUT'],
    validTriggers: ['MOMENTUM_BREAKOUT'],
    bestStrategy: 'MOMENTUM_BREAKOUT',
    direction: 'BUY',
    confidence: 0.82,
    status: 'VALID_STRATEGY_EVIDENCE',
    reasonCodes: ['TRIGGER_MET_CONFIDENCE_QUALIFIED'],
    dataSufficiency: { bars: 'AVAILABLE' },
    ...overrides,
  };
}

describe('convertFastEvaluationToCanonicalIdea', () => {
  it('converts a VALID_STRATEGY_EVIDENCE result into a canonical idea, preserving the ORIGINAL strategy identity (never a Fast-Lane-specific label)', () => {
    const converted = convertFastEvaluationToCanonicalIdea(fakeResult(), fakeCandidate());
    expect(converted.ok).toBe(true);
    if (converted.ok === false) throw new Error('unreachable');
    expect(converted.idea.strategy).toBe('MOMENTUM_BREAKOUT');
    expect(converted.idea.strategy).not.toBe('FAST_LANE_BUY');
    expect(converted.idea.agent).toBe('FastOpportunityLane');
    expect(converted.idea.side).toBe('BUY');
    expect(converted.idea.confidence).toBe(0.82); // raw strategy confidence, no Fast Lane bonus
    expect(converted.idea.evidence.origin).toBe('FAST_OPPORTUNITY_LANE');
  });

  it('preserves full provenance: candidateId, fastEvaluationId, detectionSource, catalyst, timestamps, marketDataType, validUntil', () => {
    const result = fakeResult();
    const candidate = fakeCandidate();
    const converted = convertFastEvaluationToCanonicalIdea(result, candidate);
    if (converted.ok === false) throw new Error('unreachable');
    expect(converted.idea.evidence.candidateId).toBe(candidate.id);
    expect(converted.idea.evidence.fastEvaluationId).toBe(result.id);
    expect(converted.idea.evidence.detectionSource).toBe(candidate.detectionSource);
    expect(converted.idea.evidence.catalyst).toBe(candidate.catalyst);
    expect(converted.idea.evidence.detectedAt).toBe(candidate.detectedAt);
    expect(converted.idea.evidence.dataAsOf).toBe(result.dataAsOf);
    expect(converted.idea.evidence.evaluatedAt).toBe(result.evaluatedAt);
    expect(converted.idea.evidence.marketDataType).toBe(result.marketDataType);
    expect(converted.idea.evidence.validUntil).toBe(candidate.expiresAt);
  });

  // The mandate's own explicit gates (Section 2): NO_VALID_SETUP, INSUFFICIENT_DATA, ERROR, and
  // EXPIRED must NEVER produce an idea.
  it.each(['NO_VALID_SETUP', 'INSUFFICIENT_DATA', 'ERROR', 'EXPIRED', 'DATA_STALE'] as const)('status=%s never produces a canonical idea', (status) => {
    const converted = convertFastEvaluationToCanonicalIdea(fakeResult({ status, bestStrategy: undefined, direction: undefined, confidence: undefined, validTriggers: [] }), fakeCandidate());
    expect(converted.ok).toBe(false);
    if (converted.ok === true) throw new Error('unreachable');
    expect(converted.reason).toBe('STATUS_NOT_VALID_EVIDENCE');
  });

  it('rejects an expired candidate even if the result itself claims VALID_STRATEGY_EVIDENCE - no stale momentum resurrection', () => {
    const expiredCandidate = fakeCandidate({ expiresAt: Date.now() - 1000 });
    const converted = convertFastEvaluationToCanonicalIdea(fakeResult(), expiredCandidate);
    expect(converted.ok).toBe(false);
    if (converted.ok === true) throw new Error('unreachable');
    expect(converted.reason).toBe('CANDIDATE_EXPIRED');
  });

  it('rejects when no real trigger exists (validTriggers empty) even if status claims VALID_STRATEGY_EVIDENCE - never trusts the label alone', () => {
    const converted = convertFastEvaluationToCanonicalIdea(fakeResult({ validTriggers: [] }), fakeCandidate());
    expect(converted.ok).toBe(false);
    if (converted.ok === true) throw new Error('unreachable');
    expect(converted.reason).toBe('NO_TRIGGER');
  });

  it('rejects NaN/Infinity confidence - fails closed, never fabricates a usable idea from a corrupt value', () => {
    for (const badConfidence of [NaN, Infinity, -Infinity]) {
      const converted = convertFastEvaluationToCanonicalIdea(fakeResult({ confidence: badConfidence }), fakeCandidate());
      expect(converted.ok).toBe(false);
      if (converted.ok === true) throw new Error('unreachable');
      expect(converted.reason).toBe('NON_FINITE_CONFIDENCE');
    }
  });

  it('rejects MISSING_STRATEGY_IDENTITY when status is VALID but bestStrategy is absent - never converts an idea with no strategy to attribute', () => {
    const converted = convertFastEvaluationToCanonicalIdea(fakeResult({ bestStrategy: undefined }), fakeCandidate());
    expect(converted.ok).toBe(false);
    if (converted.ok === true) throw new Error('unreachable');
    expect(converted.reason).toBe('MISSING_STRATEGY_IDENTITY');
  });

  it('rejects MISSING_DIRECTION_OR_CONFIDENCE when direction is absent', () => {
    const converted = convertFastEvaluationToCanonicalIdea(fakeResult({ direction: undefined }), fakeCandidate());
    expect(converted.ok).toBe(false);
    if (converted.ok === true) throw new Error('unreachable');
    expect(converted.reason).toBe('MISSING_DIRECTION_OR_CONFIDENCE');
  });

  it('rejects MISSING_DIRECTION_OR_CONFIDENCE when confidence is null', () => {
    const converted = convertFastEvaluationToCanonicalIdea(fakeResult({ confidence: null as unknown as number }), fakeCandidate());
    expect(converted.ok).toBe(false);
    if (converted.ok === true) throw new Error('unreachable');
    expect(converted.reason).toBe('MISSING_DIRECTION_OR_CONFIDENCE');
  });

  it('converts a SELL direction result correctly - side flows through, strategy identity preserved', () => {
    const converted = convertFastEvaluationToCanonicalIdea(
      fakeResult({ direction: 'SELL', bestStrategy: 'MEAN_REVERSION', validTriggers: ['MEAN_REVERSION'] }),
      fakeCandidate(),
    );
    expect(converted.ok).toBe(true);
    if (converted.ok === false) throw new Error('unreachable');
    expect(converted.idea.side).toBe('SELL');
    expect(converted.idea.strategy).toBe('MEAN_REVERSION');
    expect(converted.idea.agent).toBe('FastOpportunityLane');
  });

  it('handles a null catalyst - evidence.catalyst is null, not undefined or a crash', () => {
    const converted = convertFastEvaluationToCanonicalIdea(fakeResult(), fakeCandidate({ catalyst: undefined }));
    expect(converted.ok).toBe(true);
    if (converted.ok === false) throw new Error('unreachable');
    expect(converted.idea.evidence.catalyst).toBeNull();
  });
});

describe('computeEvidenceFingerprint', () => {
  it('is stable for the same strategy/symbol/side/dataAsOf-minute, regardless of volatile fields', () => {
    const baseMs = 1_700_000_000_000;
    const a = computeEvidenceFingerprint({ strategy: 'MOMENTUM_BREAKOUT', symbol: 'AAPL', side: 'BUY', dataAsOf: baseMs });
    const b = computeEvidenceFingerprint({ strategy: 'MOMENTUM_BREAKOUT', symbol: 'AAPL', side: 'BUY', dataAsOf: baseMs + 5_000 }); // same minute bucket
    expect(a).toBe(b);
  });

  it('differs when strategy, symbol, or side differs', () => {
    const base = { strategy: 'MOMENTUM_BREAKOUT', symbol: 'AAPL', side: 'BUY' as const, dataAsOf: 1_700_000_000_000 };
    expect(computeEvidenceFingerprint(base)).not.toBe(computeEvidenceFingerprint({ ...base, strategy: 'MEAN_REVERSION' }));
    expect(computeEvidenceFingerprint(base)).not.toBe(computeEvidenceFingerprint({ ...base, symbol: 'MSFT' }));
    expect(computeEvidenceFingerprint(base)).not.toBe(computeEvidenceFingerprint({ ...base, side: 'SELL' }));
  });

  it('differs across different data-as-of minute buckets - real fresher evidence is not conflated with stale', () => {
    const base = { strategy: 'MOMENTUM_BREAKOUT', symbol: 'AAPL', side: 'BUY' as const };
    const a = computeEvidenceFingerprint({ ...base, dataAsOf: 1_700_000_000_000 });
    const b = computeEvidenceFingerprint({ ...base, dataAsOf: 1_700_000_120_000 }); // 2 minutes later
    expect(a).not.toBe(b);
  });

  it('handles null dataAsOf with the unknown bucket - two null-dataAsOf evidences fingerprint identically, null vs real differ', () => {
    const base = { strategy: 'MOMENTUM_BREAKOUT', symbol: 'AAPL', side: 'BUY' as const };
    const a = computeEvidenceFingerprint({ ...base, dataAsOf: null });
    const b = computeEvidenceFingerprint({ ...base, dataAsOf: null });
    expect(a).toBe(b);
    expect(a).toContain('unknown');
    const c = computeEvidenceFingerprint({ ...base, dataAsOf: 1_700_000_000_000 });
    expect(a).not.toBe(c);
  });
});
