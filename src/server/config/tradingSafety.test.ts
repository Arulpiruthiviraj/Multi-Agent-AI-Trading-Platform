import { describe, it, expect } from 'vitest';
import { tradingSafety } from './tradingSafety';
import { netConfidenceFromVotes } from '../services/EvidenceAggregator';

describe('tradingSafety.json', () => {
  it('loads finite safety thresholds used by RiskEngine and consensus', () => {
    expect(tradingSafety.stalePriceThresholdMs).toBeGreaterThan(0);
    expect(tradingSafety.maxConsecutiveLosses).toBeGreaterThan(0);
    expect(tradingSafety.disagreementPenalty).toBeGreaterThan(0);
    expect(tradingSafety.consensusApprovalThreshold).toBeGreaterThan(0);
    expect(tradingSafety.consensusApprovalThreshold).toBeLessThan(1);
  });

  it('netConfidenceFromVotes uses the configured disagreement penalty, not a test-local 0.5', () => {
    const buy = { confidence: 0.9, weight: 1.0 };
    const hold = { confidence: 0.9, weight: 1.0 };
    const expected =
      (buy.confidence * buy.weight - hold.confidence * hold.weight * tradingSafety.disagreementPenalty) /
      (buy.weight + hold.weight);
    expect(netConfidenceFromVotes([buy], [hold])).toBeCloseTo(expected, 10);
  });
});
