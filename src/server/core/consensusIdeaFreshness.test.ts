import { describe, it, expect } from 'vitest';
import { isConsensusIdeaFresh } from './consensusIdeaFreshness';
import { tradingSafety } from '../config/tradingSafety';

describe('consensusIdeaFreshness', () => {
  it('treats missing receivedAt as fresh (backward compatible)', () => {
    expect(isConsensusIdeaFresh(undefined, Date.now())).toBe(true);
  });

  it('drops votes older than consensusIdeaMaxAgeMs without changing the 0.75 / min-2 bars', () => {
    const now = 1_700_000_000_000;
    expect(isConsensusIdeaFresh(now - tradingSafety.consensusIdeaMaxAgeMs + 1, now)).toBe(true);
    expect(isConsensusIdeaFresh(now - tradingSafety.consensusIdeaMaxAgeMs - 1, now)).toBe(false);
    expect(tradingSafety.consensusApprovalThreshold).toBe(0.75);
    expect(tradingSafety.minIndependentAgreeingAgents).toBe(2);
  });
});
