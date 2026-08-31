import { describe, it, expect, beforeEach } from 'vitest';
import {
  upsertCandidate,
  markCandidatePromoted,
  getCandidate,
  listCandidates,
  expireStaleCandidates,
  resetCandidatesForTests,
} from './candidateLifecycle';

describe('candidateLifecycle', () => {
  beforeEach(() => resetCandidatesForTests());

  it('upsertCandidate records a real DISCOVERED/WATCHING state with a real timestamp', () => {
    const now = 1_000_000;
    upsertCandidate({ symbol: 'aapl', state: 'DISCOVERED', reason: 'shortlisted', now });
    const rec = getCandidate('AAPL')!;
    expect(rec.state).toBe('DISCOVERED');
    expect(rec.updatedAt).toBe(now);
  });

  describe('expireStaleCandidates (Phase 9 time-bounded evaluation window)', () => {
    it('never actually reached STALE before this fix - confirms the real gap this closes', () => {
      // Prior to this fix, nothing in the codebase ever set state: 'STALE' - this test documents
      // the exact defect: a candidate untouched for a long time just sat at its last real state.
      upsertCandidate({ symbol: 'OLD', state: 'DISCOVERED', now: 0 });
      expect(getCandidate('OLD')!.state).toBe('DISCOVERED');
      // Without calling expireStaleCandidates, it would stay DISCOVERED forever, however old it gets.
    });

    it('transitions a DISCOVERED candidate to STALE once it exceeds the max age', () => {
      upsertCandidate({ symbol: 'OLD', state: 'DISCOVERED', now: 0 });
      const expiredCount = expireStaleCandidates(300_000, 400_000);
      expect(expiredCount).toBe(1);
      expect(getCandidate('OLD')!.state).toBe('STALE');
    });

    it('transitions a WATCHING candidate to STALE once it exceeds the max age', () => {
      upsertCandidate({ symbol: 'OLD', state: 'WATCHING', now: 0 });
      expireStaleCandidates(300_000, 400_000);
      expect(getCandidate('OLD')!.state).toBe('STALE');
    });

    it('does NOT expire a candidate that is still within the max age window', () => {
      upsertCandidate({ symbol: 'FRESH', state: 'DISCOVERED', now: 100_000 });
      const expiredCount = expireStaleCandidates(300_000, 200_000);
      expect(expiredCount).toBe(0);
      expect(getCandidate('FRESH')!.state).toBe('DISCOVERED');
    });

    it('never demotes an already-PROMOTED candidate, even if old - that is a real, final outcome for that scan', () => {
      markCandidatePromoted('WINNER', 0);
      expireStaleCandidates(300_000, 400_000);
      expect(getCandidate('WINNER')!.state).toBe('PROMOTED');
    });

    it('never demotes an already-FILTERED_OUT candidate, even if old', () => {
      upsertCandidate({ symbol: 'REJECTED', state: 'FILTERED_OUT', now: 0 });
      expireStaleCandidates(300_000, 400_000);
      expect(getCandidate('REJECTED')!.state).toBe('FILTERED_OUT');
    });

    it('is idempotent - re-running against an already-STALE candidate does not error or re-count it', () => {
      upsertCandidate({ symbol: 'OLD', state: 'DISCOVERED', now: 0 });
      expireStaleCandidates(300_000, 400_000);
      const secondPassCount = expireStaleCandidates(300_000, 500_000);
      expect(secondPassCount).toBe(0);
      expect(getCandidate('OLD')!.state).toBe('STALE');
    });

    it('only expires candidates past the threshold, leaving fresher ones alone in the same pass', () => {
      upsertCandidate({ symbol: 'OLD', state: 'DISCOVERED', now: 0 });
      upsertCandidate({ symbol: 'FRESH', state: 'WATCHING', now: 350_000 });
      const expiredCount = expireStaleCandidates(300_000, 400_000);
      expect(expiredCount).toBe(1);
      expect(getCandidate('OLD')!.state).toBe('STALE');
      expect(getCandidate('FRESH')!.state).toBe('WATCHING');
    });

    it('a STALE candidate is still visible via listCandidates() - never silently disappears', () => {
      upsertCandidate({ symbol: 'OLD', state: 'DISCOVERED', now: 0 });
      expireStaleCandidates(300_000, 400_000);
      const all = listCandidates();
      expect(all.find((c) => c.symbol === 'OLD')?.state).toBe('STALE');
    });
  });
});
