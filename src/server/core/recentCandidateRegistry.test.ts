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
