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
    expect(tradingSafety.agentWinRateAlertPct).toBeGreaterThan(0);
    expect(tradingSafety.agentWinRateAlertPct).toBeLessThan(100);
    expect(tradingSafety.oosSharpeDegradationMinRatio).toBe(0.6);
    expect(tradingSafety.permutationTestIterations).toBe(1000);
    expect(tradingSafety.permutationSignificanceAlpha).toBe(0.05);
    expect(tradingSafety.minSampleSizeForTrust).toBeGreaterThan(0);
    expect(tradingSafety.reconSignificantMismatchDollars).toBeGreaterThan(0);
    expect(tradingSafety.reconPauseConsecutiveMismatchCycles).toBe(2);
    expect(tradingSafety.evaluationHorizonMs).toBeGreaterThan(0);
    expect(tradingSafety.newsVetoMinImpactScore).toBeGreaterThan(0);
    expect(tradingSafety.alphaVantageDailyRequestBudget).toBeGreaterThan(0);
    expect(tradingSafety.consensusMaxProviders).toBeGreaterThan(0);
    expect(tradingSafety.newsLlmMaxCallsPerCycle).toBeGreaterThan(0);
    expect(tradingSafety.aiProviderUnreachableCooldownMs).toBeGreaterThan(0);
    expect(tradingSafety.aiProviderTimeoutSkipCooldownMs).toBeGreaterThan(0);
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
