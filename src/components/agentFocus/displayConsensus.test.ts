import { describe, it, expect } from 'vitest';
import { netConfidenceFromVotes } from '../../server/services/EvidenceAggregator';
import { displayNetConfidenceFromVotes, CONSENSUS_APPROVAL_THRESHOLD } from './displayConsensus';
import tradingSafety from '../../../config/tradingSafety.json';
import riskGateOrder from '../../../config/riskGateOrder.json';

describe('Focus Mode display math', () => {
  it('uses tradingSafety.consensusApprovalThreshold (not a UI literal)', () => {
    expect(CONSENSUS_APPROVAL_THRESHOLD).toBe(tradingSafety.consensusApprovalThreshold);
  });

  it('matches EvidenceAggregator.netConfidenceFromVotes on the same votes', () => {
    const agreeing = [{ confidence: 0.8, weight: 0.25 }, { confidence: 0.7, weight: 0.2 }];
    const disagreeing = [{ confidence: 0.6, weight: 0.15 }];
    expect(displayNetConfidenceFromVotes(agreeing, disagreeing)).toBeCloseTo(
      netConfidenceFromVotes(agreeing, disagreeing),
      10,
    );
  });

  it('riskGateOrder.json is a non-empty string catalog (pass/fail still comes from events)', () => {
    expect(Array.isArray(riskGateOrder.gates)).toBe(true);
    expect(riskGateOrder.gates.length).toBeGreaterThan(0);
    expect(riskGateOrder.gates.every((g) => typeof g === 'string' && g.length > 0)).toBe(true);
  });
});
