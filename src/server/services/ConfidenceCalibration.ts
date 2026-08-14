/**
 * ==========================================================
 * Module: ConfidenceCalibration
 *
 * Purpose:
 * Real Beta-Binomial confidence calibration - Phase 1A of FINAL_ANALYSIS.md's 4-phase
 * remediation plan. Distinct from agentPerformanceStats.currentWeight (a flat, agent-wide scalar
 * driven by OVERALL win rate): this corrects a specific agent's specific STATED confidence level
 * against its own real historical accuracy at that level. NewsAgent's real, measured finding
 * (FINAL_ANALYSIS.md 15.0/15.4) is exactly the case this exists for - its 80-90%-stated-
 * confidence bucket resolves to ~34.2% actual accuracy at n=76, a calibration failure a flat
 * per-agent weight cannot see: an agent can have a perfectly reasonable OVERALL win rate while
 * still being systematically overconfident specifically when it claims high confidence.
 *
 * The math (real Beta-Binomial conjugate updating, not a naive raw-average or an unlabeled
 * heuristic dressed up as "Bayesian"):
 *   - Prior: Beta(alpha0, beta0), centered on the bucket's own midpoint, with pseudo-sample-size
 *     PRIOR_STRENGTH. Before any real evidence exists, this trusts the agent's own stated
 *     confidence - exactly as strongly as if backed by PRIOR_STRENGTH real observations.
 *   - Posterior mean = (wins + alpha0) / (wins + losses + alpha0 + beta0).
 *   - With few real observations (e.g. a 1-prediction agent), the posterior stays close to the
 *     prior - appropriately, since there's no real evidence yet to justify overriding the
 *     agent's own claim. With many real observations (NewsAgent's n=76), the posterior is
 *     dominated by the real data and correctly converges toward the real ~34% accuracy,
 *     regardless of what the agent claims.
 * ==========================================================
 */

export interface ConfidenceBucket {
  low: number; // inclusive
  high: number; // exclusive, except the final bucket's upper bound (1.0) is inclusive
}

// Fixed bands rather than deciles - coarse enough to accumulate real sample size quickly, fine
// enough to isolate the specific high-confidence overconfidence pattern this exists to catch.
export const CONFIDENCE_BUCKETS: readonly ConfidenceBucket[] = [
  { low: 0, high: 0.6 },
  { low: 0.6, high: 0.7 },
  { low: 0.7, high: 0.8 },
  { low: 0.8, high: 0.9 },
  { low: 0.9, high: 1.0 },
];

// Pseudo-observation count backing the prior - weak enough that ~20-30 real observations already
// dominate it, strong enough that a single lucky/unlucky outcome can't swing the calibrated value.
export const PRIOR_STRENGTH = 10;

export function bucketFor(confidence: number): ConfidenceBucket {
  const clamped = Math.max(0, Math.min(1, confidence));
  for (const bucket of CONFIDENCE_BUCKETS) {
    if (clamped >= bucket.low && (clamped < bucket.high || bucket.high >= 1)) {
      return bucket;
    }
  }
  return CONFIDENCE_BUCKETS[CONFIDENCE_BUCKETS.length - 1];
}

export function bucketMidpoint(bucket: ConfidenceBucket): number {
  return (bucket.low + Math.min(bucket.high, 1)) / 2;
}

/** Real Beta-Binomial conjugate posterior mean - see module header for the derivation. */
export function betaBinomialPosteriorMean(
  wins: number,
  losses: number,
  priorMean: number,
  priorStrength: number = PRIOR_STRENGTH
): number {
  const alpha0 = priorMean * priorStrength;
  const beta0 = (1 - priorMean) * priorStrength;
  return (wins + alpha0) / (wins + losses + alpha0 + beta0);
}

export function calibratedConfidenceForBucket(bucket: ConfidenceBucket, wins: number, losses: number): number {
  return betaBinomialPosteriorMean(wins, losses, bucketMidpoint(bucket));
}
