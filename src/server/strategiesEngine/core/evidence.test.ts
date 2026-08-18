import { describe, it, expect } from 'vitest';
import { promoteEvidence, deriveEvidenceFlags, EVIDENCE_LADDER, DEFAULT_EVIDENCE_STATE } from './evidence';
import { createStrategy, withEvidenceState, CreateStrategyInput } from './createStrategy';
import { leaf } from '../conditions/ConditionTypes';

function input(overrides: Partial<CreateStrategyInput> = {}): CreateStrategyInput {
  return {
    name: 'Test', family: 'TREND', implementationStatus: 'REAL', requiredIndicators: [],
    entryConditions: leaf('Always'), confirmationConditions: null, invalidationConditions: null, exitConditions: null,
    stopLoss: { kind: 'ATR_MULTIPLE', value: 2, basis: 'test' }, takeProfit: null,
    positionSizing: { kind: 'FIXED_FRACTIONAL', value: 0.01, basis: 'test' },
    parameters: [], parameterValues: {}, dependencies: [],
    metadata: { description: 'x', tags: [], assetClasses: ['EQUITY'], timeframes: ['1d'], marketRegimes: ['TRENDING_UP'], origin: 'BASE' },
    ...overrides,
  };
}

describe('createStrategy defaults', () => {
  it('defaults evidenceState to EXPERIMENTAL (Section 6 fail-closed default)', () => {
    const s = createStrategy(input());
    expect(s.evidenceState).toBe('EXPERIMENTAL');
    expect(DEFAULT_EVIDENCE_STATE).toBe('EXPERIMENTAL');
  });

  it('evidenceState is NOT part of the deterministic id (evidence maturing != a new strategy)', () => {
    const a = createStrategy(input({ evidenceState: 'EXPERIMENTAL' }));
    const b = createStrategy(input({ evidenceState: 'ROBUST' }));
    expect(a.id).toBe(b.id);
  });
});

describe('promoteEvidence - the real fail-closed ladder', () => {
  it('CRITICAL SAFETY: an EXPERIMENTAL strategy cannot jump directly to LIVE_ELIGIBLE', () => {
    const result = promoteEvidence('EXPERIMENTAL', 'LIVE_ELIGIBLE', 'trying to skip ahead');
    expect(result.ok).toBe(false);
    expect(result.newState).toBe('EXPERIMENTAL');
  });

  it('CRITICAL SAFETY: an UNVALIDATED (UNTESTED) strategy cannot become live-eligible automatically', () => {
    const result = promoteEvidence('UNTESTED', 'LIVE_ELIGIBLE', 'no evidence at all');
    expect(result.ok).toBe(false);
  });

  it('allows exactly one real forward step at a time', () => {
    let state = EVIDENCE_LADDER[0];
    for (let i = 1; i < EVIDENCE_LADDER.length; i++) {
      const result = promoteEvidence(state, EVIDENCE_LADDER[i], `real evidence step ${i}`);
      expect(result.ok).toBe(true);
      state = result.newState;
    }
    expect(state).toBe('LIVE_ELIGIBLE');
  });

  it('rejects skipping any single rung, at every position in the ladder', () => {
    for (let i = 0; i < EVIDENCE_LADDER.length - 2; i++) {
      const result = promoteEvidence(EVIDENCE_LADDER[i], EVIDENCE_LADDER[i + 2], 'skip attempt');
      expect(result.ok).toBe(false);
    }
  });

  it('always allows demotion (real evidence can get worse)', () => {
    const result = promoteEvidence('ROBUST', 'BACKTESTED', 'a robustness re-run failed');
    expect(result.ok).toBe(true);
    expect(result.newState).toBe('BACKTESTED');
  });

  it('rejects a promotion with no reason', () => {
    const result = promoteEvidence('EXPERIMENTAL', 'BACKTESTED', '');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/reason/i);
  });

  it('rejects a same-state "promotion"', () => {
    const result = promoteEvidence('BACKTESTED', 'BACKTESTED', 'no-op');
    expect(result.ok).toBe(false);
  });
});

describe('deriveEvidenceFlags', () => {
  it('only LIVE_ELIGIBLE state has liveEligible=true', () => {
    for (const state of EVIDENCE_LADDER) {
      const flags = deriveEvidenceFlags(state);
      expect(flags.liveEligible).toBe(state === 'LIVE_ELIGIBLE');
    }
  });

  it('validated is true only from BACKTESTED onward', () => {
    expect(deriveEvidenceFlags('UNTESTED').validated).toBe(false);
    expect(deriveEvidenceFlags('EXPERIMENTAL').validated).toBe(false);
    expect(deriveEvidenceFlags('BACKTESTED').validated).toBe(true);
    expect(deriveEvidenceFlags('LIVE_ELIGIBLE').validated).toBe(true);
  });

  it('promotable is true only from ROBUST onward', () => {
    expect(deriveEvidenceFlags('WFO_TESTED').promotable).toBe(false);
    expect(deriveEvidenceFlags('ROBUST').promotable).toBe(true);
  });
});

describe('withEvidenceState', () => {
  it('changes evidenceState without changing id or version', () => {
    const original = createStrategy(input());
    const promoted = withEvidenceState(original, 'BACKTESTED');
    expect(promoted.id).toBe(original.id);
    expect(promoted.version).toBe(original.version);
    expect(promoted.evidenceState).toBe('BACKTESTED');
    expect(original.evidenceState).toBe('EXPERIMENTAL'); // original untouched
  });

  it('returns a frozen object', () => {
    const promoted = withEvidenceState(createStrategy(input()), 'BACKTESTED');
    expect(Object.isFrozen(promoted)).toBe(true);
  });
});
