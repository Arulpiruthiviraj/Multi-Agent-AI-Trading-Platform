import { describe, expect, it } from 'vitest';
import { DEFAULT_CALIBRATION_SEEDS } from './simCliArgs';

/**
 * 2026-09-21, Synthetic Certification Framework Hardening Phase 1. Locks in the comprehensive
 * calibration-seed matrix that replaced the reactive 5-pair list - see DEFAULT_CALIBRATION_SEEDS'
 * own header comment in simCliArgs.ts for the real, log-evidenced root cause this fixes (a
 * genuinely-independent QQQ 64.5%/AAPL 68.0% MODERATE-tier agreement was rejected with
 * MODERATE_REJECT_UNTRUSTED_CALIBRATION because the 0.7-0.8 and 0.9-1.0 buckets were never seeded
 * for any agent, and the agent roster itself was incomplete).
 */
describe('DEFAULT_CALIBRATION_SEEDS (comprehensive calibration-trust coverage)', () => {
  const CANONICAL_BUCKETS = [
    { bucketLow: 0, bucketHigh: 0.6 },
    { bucketLow: 0.6, bucketHigh: 0.7 },
    { bucketLow: 0.7, bucketHigh: 0.8 },
    { bucketLow: 0.8, bucketHigh: 0.9 },
    { bucketLow: 0.9, bucketHigh: 1.0 },
  ];
  const ELIGIBLE_AGENTS = ['TechnicalAgent', 'QuantEngine', 'JavaCoreEnsemble', 'JavaFactorComposite', 'KronosEngine', 'OpportunityScreener'];

  it('seeds every canonical confidence bucket (mirrors ConfidenceCalibration.ts CONFIDENCE_BUCKETS) for every calibration-eligible agent - no gaps', () => {
    expect(DEFAULT_CALIBRATION_SEEDS).toHaveLength(ELIGIBLE_AGENTS.length * CANONICAL_BUCKETS.length);
    for (const agentName of ELIGIBLE_AGENTS) {
      for (const bucket of CANONICAL_BUCKETS) {
        const found = DEFAULT_CALIBRATION_SEEDS.some(
          (s) => s.agentName === agentName && s.bucketLow === bucket.bucketLow && s.bucketHigh === bucket.bucketHigh,
        );
        expect(found, `missing seed for ${agentName} [${bucket.bucketLow}-${bucket.bucketHigh}]`).toBe(true);
      }
    }
  });

  it('never seeds ConsensusDebate - ChiefTraderAgent.ts filters it out of agreeingAgents entirely, so a seed for it would be dead weight', () => {
    expect(DEFAULT_CALIBRATION_SEEDS.some((s) => s.agentName === 'ConsensusDebate')).toBe(false);
  });

  it('the historically-critical (agent, bucket) pairs from the original SPY convergence remain covered (regression guard, not a re-narrowing)', () => {
    const pairs = [
      { agentName: 'JavaCoreEnsemble', bucketLow: 0.6, bucketHigh: 0.7 },
      { agentName: 'KronosEngine', bucketLow: 0.8, bucketHigh: 0.9 },
      { agentName: 'TechnicalAgent', bucketLow: 0.6, bucketHigh: 0.7 },
      { agentName: 'TechnicalAgent', bucketLow: 0, bucketHigh: 0.6 },
    ];
    for (const p of pairs) {
      expect(DEFAULT_CALIBRATION_SEEDS).toContainEqual(p);
    }
    // The real, log-evidenced 2026-09-20 QQQ/AAPL failure pairs (previously uncovered) are now covered too.
    expect(DEFAULT_CALIBRATION_SEEDS).toContainEqual({ agentName: 'KronosEngine', bucketLow: 0.6, bucketHigh: 0.7 });
    expect(DEFAULT_CALIBRATION_SEEDS).toContainEqual({ agentName: 'TechnicalAgent', bucketLow: 0.7, bucketHigh: 0.8 });
  });
});
