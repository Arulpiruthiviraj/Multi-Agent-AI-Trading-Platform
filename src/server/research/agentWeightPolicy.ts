import { tradingSafety } from '../config/tradingSafety';

export function agentWeightUpdate(opts: {
  totalEvaluated: number;
  winRate: number;
}): { currentWeight: number; sharpeRatio: number; statisticallyMeaningful: boolean } {
  const min = tradingSafety.minSampleSizeForTrust;
  if (opts.totalEvaluated < min) {
    return { currentWeight: 1.0, sharpeRatio: 0, statisticallyMeaningful: false };
  }
  const currentWeight = Math.max(0.1, 1.0 + ((opts.winRate - 0.5) * 2));
  return { currentWeight, sharpeRatio: 0, statisticallyMeaningful: true };
}

/**
 * ARGUS_INDEPENDENT_LEARNING_AND_REGIME_IMPLEMENTATION_AUDIT.md Phase 8 - moves `previous` toward
 * `target` by at most `maxDelta` in one call. One noisy effective-sample evaluation cycle can
 * therefore never snap a live agent weight straight to an extreme value; it takes several
 * consecutive cycles of consistent evidence to get there. Used both when evidence supports a new
 * learned weight (target = computed weight) and when evidence has become insufficient (target =
 * the agent's static default weight) - the same bounded-step mechanism serves the "gradual
 * adjustment" and "gradual rollback to neutral" requirements identically.
 */
export function boundedStep(previous: number, target: number, maxDelta: number): number {
  const delta = target - previous;
  if (Math.abs(delta) <= maxDelta) return target;
  return previous + Math.sign(delta) * maxDelta;
}
