import { describe, it, expect } from 'vitest';
import { classifyExclusionReason, scoreBroadUniverseChallenger } from './OpportunityDiscovery';

/**
 * 2026-10-05 (challenger zero-score visibility): regression tests for the per-symbol
 * exclusion reason codes. Each code maps to an actual scoring branch — not invented.
 */
describe('classifyExclusionReason', () => {
  const emptyMovers = new Set<string>();

  it('A: valid positive score is not excluded (control)', () => {
    // A candidate with baseScore 1.0, no gap, no mover bonus → finalScore 1.0 > 0 → eligible.
    // classifyExclusionReason is only called for excluded candidates, but verify the
    // scoring produces a positive score.
    const score = scoreBroadUniverseChallenger('GOOD', null, () => 1.0);
    expect(score).toBeGreaterThan(0);
  });

  it('B: zero base score with no gap/composable/mover → NO_SCORE_EVIDENCE', () => {
    const reason = classifyExclusionReason('IOVA_LIKE', {
      finalScore: 0, baseScore: 0, gapPct: null, gapTerm: 0, hasGapEvidence: false,
    }, emptyMovers);
    expect(reason).toBe('NO_SCORE_EVIDENCE');
  });

  it('C: NaN component → NAN_SCORE (fail closed)', () => {
    const reason = classifyExclusionReason('NANSTOCK', {
      finalScore: NaN, baseScore: NaN, gapPct: null, gapTerm: 0, hasGapEvidence: false,
    }, emptyMovers);
    expect(reason).toBe('NAN_SCORE');
    // NaN must not pass the eligibility filter (NaN > 0 is false).
    expect(NaN > 0).toBe(false);
  });

  it('D: Infinite score → INFINITE_SCORE', () => {
    const reason = classifyExclusionReason('INFSTOCK', {
      finalScore: Infinity, baseScore: Infinity, gapPct: null, gapTerm: 0, hasGapEvidence: false,
    }, emptyMovers);
    expect(reason).toBe('INFINITE_SCORE');
  });

  it('E: missing gap evidence but valid base score → follows existing design', () => {
    // Base score 0.5, no gap → finalScore 0.5 > 0 → ELIGIBLE (gap is additive, not required).
    const score = scoreBroadUniverseChallenger('BASEONLY', null, () => 0.5);
    expect(score).toBe(0.5);
    expect(score > 0).toBe(true);
  });

  it('F: zero base with gap evidence → gap term can rescue (not NO_SCORE_EVIDENCE)', () => {
    const reason = classifyExclusionReason('GAPONLY', {
      finalScore: 0.1, baseScore: 0, gapPct: 0.05, gapTerm: 0.1, hasGapEvidence: true,
    }, emptyMovers);
    // Has gap evidence, so not the "nothing at all" case.
    expect(reason).not.toBe('NO_SCORE_EVIDENCE');
  });

  it('distinguishes NO_BASE_SCORE from NO_SCORE_EVIDENCE', () => {
    // Base 0 but has gap evidence (gapTerm 0 because gapPct is 0) → NO_BASE_SCORE, not NO_SCORE_EVIDENCE.
    const reason = classifyExclusionReason('ZEROGAP', {
      finalScore: 0, baseScore: 0, gapPct: 0, gapTerm: 0, hasGapEvidence: true,
    }, emptyMovers);
    expect(reason).toBe('NO_BASE_SCORE');
  });

  it('verified mover with zero base is not NO_SCORE_EVIDENCE', () => {
    const movers = new Set(['MOVERSTOCK']);
    const reason = classifyExclusionReason('MOVERSTOCK', {
      finalScore: 0, baseScore: 0, gapPct: null, gapTerm: 0, hasGapEvidence: false,
    }, movers);
    expect(reason).not.toBe('NO_SCORE_EVIDENCE');
  });
});
