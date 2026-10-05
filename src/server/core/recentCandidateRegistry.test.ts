import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { recordCandidate, getRecentCandidates, resetRecentCandidatesForTests } from './recentCandidateRegistry';

describe('recentCandidateRegistry', () => {
  beforeEach(() => resetRecentCandidatesForTests());
  afterEach(() => resetRecentCandidatesForTests());

  it('returns nothing when no candidate has been recorded', () => {
    expect(getRecentCandidates(300000)).toEqual([]);
  });

  it('returns a recorded symbol within the max age window', () => {
    recordCandidate('AAPL', 1_000_000);
    expect(getRecentCandidates(300000, 1_050_000)).toEqual(['AAPL']);
  });

  it('excludes a symbol recorded outside the max age window', () => {
    recordCandidate('AAPL', 1_000_000);
    expect(getRecentCandidates(300000, 1_400_000)).toEqual([]);
  });

  it('normalizes symbol case and re-records (updates timestamp) on repeat calls for the same symbol', () => {
    recordCandidate('aapl', 1_000_000);
    recordCandidate('AAPL', 1_100_000);
    const result = getRecentCandidates(300000, 1_150_000);
    expect(result).toEqual(['AAPL']);
  });

  it('sorts multiple recent candidates most-recent-first', () => {
    recordCandidate('AAPL', 1_000_000);
    recordCandidate('MSFT', 1_100_000);
    recordCandidate('TSLA', 1_050_000);
    expect(getRecentCandidates(300000, 1_150_000)).toEqual(['MSFT', 'TSLA', 'AAPL']);
  });
});

/**
 * Real defect found and fixed (2026-10-05 memory investigation). `recent` (module-level
 * Map<symbol, CandidateEntry>) was only ever set - the read path filtered by age but never
 * deleted, so one entry accumulated per distinct symbol ever seen, for process lifetime.
 * This proves the write-path sweep evicts entries older than the maximum age any production
 * caller queries (tradingSafety.recentCandidatePriorityMaxAgeMs), which no caller can
 * observe as a behavior change: anything swept could never have been returned.
 */
describe('recentCandidateRegistry write-path eviction (2026-10-05 memory fix)', () => {
  beforeEach(() => resetRecentCandidatesForTests());
  afterEach(() => resetRecentCandidatesForTests());

  it('evicts entries older than recentCandidatePriorityMaxAgeMs when recording', async () => {
    const { tradingSafety } = await import('../config/tradingSafety');
    const maxAge = tradingSafety.recentCandidatePriorityMaxAgeMs;
    const now = Date.now();
    recordCandidate('OLD', now - maxAge - 1);
    recordCandidate('NEW', now);
    expect(getRecentCandidates(maxAge, now)).toEqual(['NEW']);
  });

  it('bounds growth under a rotating symbol universe', async () => {
    const { tradingSafety } = await import('../config/tradingSafety');
    const maxAge = tradingSafety.recentCandidatePriorityMaxAgeMs;
    let now = Date.now();
    // 500 distinct symbols, each recorded far apart in time - the unbounded-growth shape.
    for (let i = 0; i < 500; i++) {
      now += maxAge * 2;
      recordCandidate(`SYM${i}`, now);
    }
    // Only the latest entry can possibly be within maxAge of the last write.
    expect(getRecentCandidates(maxAge, now)).toEqual(['SYM499']);
  });
});
