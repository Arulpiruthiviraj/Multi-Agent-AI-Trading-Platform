import { describe, it, expect } from 'vitest';
import { classifyExclusionReason, scoreBroadUniverseChallenger, isEligibleFinalScore } from './OpportunityDiscovery';

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

  // 2026-10-06 (Phase 1 fail-closed fix, October 5 follow-up): a prior version of this test
  // asserted 'INFINITE_SCORE' and treated reaching classifyExclusionReason() with an Infinite
  // score as the expected/only concern. That missed the real defect: isEligibleFinalScore() (the
  // actual real eligibility check) must itself reject +Infinity BEFORE this classifier is ever
  // consulted - `Infinity > 0` is true in JS, so the old bare `finalScore > 0` check let it through
  // as eligible. +Infinity and -Infinity now get distinct reason codes, matching NaN's own
  // already-distinct code, rather than one shared ambiguous bucket.
  it('D: +Infinity score is REJECTED by isEligibleFinalScore (fail-closed) and classified POSITIVE_INFINITY_SCORE', () => {
    expect(isEligibleFinalScore(Infinity)).toBe(false);
    const reason = classifyExclusionReason('INFSTOCK', {
      finalScore: Infinity, baseScore: Infinity, gapPct: null, gapTerm: 0, hasGapEvidence: false,
    }, emptyMovers);
    expect(reason).toBe('POSITIVE_INFINITY_SCORE');
  });

  it('D2: -Infinity score is REJECTED by isEligibleFinalScore (fail-closed) and classified NEGATIVE_INFINITY_SCORE', () => {
    expect(isEligibleFinalScore(-Infinity)).toBe(false);
    const reason = classifyExclusionReason('NEGINFSTOCK', {
      finalScore: -Infinity, baseScore: -Infinity, gapPct: null, gapTerm: 0, hasGapEvidence: false,
    }, emptyMovers);
    expect(reason).toBe('NEGATIVE_INFINITY_SCORE');
  });

  it('isEligibleFinalScore: finite positive eligible; zero/negative/NaN/+-Infinity all rejected', () => {
    expect(isEligibleFinalScore(1.5)).toBe(true);
    expect(isEligibleFinalScore(0.0001)).toBe(true);
    expect(isEligibleFinalScore(Number.MAX_SAFE_INTEGER)).toBe(true); // large but finite - existing policy, unchanged
    expect(isEligibleFinalScore(0)).toBe(false);
    expect(isEligibleFinalScore(-1)).toBe(false);
    expect(isEligibleFinalScore(NaN)).toBe(false);
    expect(isEligibleFinalScore(Infinity)).toBe(false);
    expect(isEligibleFinalScore(-Infinity)).toBe(false);
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
