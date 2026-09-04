/**
 * Loads config/evaluationHorizons.json - per-agent/per-strategy evaluation-horizon overrides.
 * See that file's own $comment for the full rationale (evaluation-horizon-mismatch remediation,
 * 2026-09-04). Missing entries are not an error - resolveEvaluationHorizonMs() in
 * predictionIndependencePolicy.ts falls back to tradingSafety.evaluationHorizonMs for those.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface EvaluationHorizonsConfig {
  byAgentName: Record<string, number>;
  byQuantStrategyId: Record<string, number>;
  /** QuantEngine strategy ids graded by a real exit-simulation evaluator (e.g.
   *  TrendFollowingExitEvaluator.ts) instead of the generic fixed-horizon evaluatePrediction(). */
  exitAwareStrategyIds: string[];
  /** How far forward an exit-aware evaluator's walk-forward search may look before an unresolved
   *  position is recorded as inconclusive (N_A) rather than retried indefinitely. */
  exitAwareMaxWalkForwardMs: number;
}

function loadEvaluationHorizons(): EvaluationHorizonsConfig {
  const raw = loadRepoConfigJson<Record<string, unknown>>('evaluationHorizons.json');

  const byAgentName = raw.byAgentName;
  if (!byAgentName || typeof byAgentName !== 'object') {
    throw new Error('config/evaluationHorizons.json missing object field: byAgentName');
  }
  const byQuantStrategyId = raw.byQuantStrategyId;
  if (!byQuantStrategyId || typeof byQuantStrategyId !== 'object') {
    throw new Error('config/evaluationHorizons.json missing object field: byQuantStrategyId');
  }
  for (const [key, value] of Object.entries({ ...byAgentName, ...byQuantStrategyId } as Record<string, unknown>)) {
    if (typeof value !== 'number' || !(value > 0)) {
      throw new Error(`config/evaluationHorizons.json entry "${key}" must be a positive number of milliseconds`);
    }
  }

  const exitAwareStrategyIds = raw.exitAwareStrategyIds;
  if (!Array.isArray(exitAwareStrategyIds) || !exitAwareStrategyIds.every((v) => typeof v === 'string')) {
    throw new Error('config/evaluationHorizons.json missing array-of-strings field: exitAwareStrategyIds');
  }
  const exitAwareMaxWalkForwardMs = raw.exitAwareMaxWalkForwardMs;
  if (typeof exitAwareMaxWalkForwardMs !== 'number' || !(exitAwareMaxWalkForwardMs > 0)) {
    throw new Error('config/evaluationHorizons.json missing positive-number field: exitAwareMaxWalkForwardMs');
  }

  return {
    byAgentName: byAgentName as Record<string, number>,
    byQuantStrategyId: byQuantStrategyId as Record<string, number>,
    exitAwareStrategyIds: exitAwareStrategyIds as string[],
    exitAwareMaxWalkForwardMs,
  };
}

export const evaluationHorizons: EvaluationHorizonsConfig = loadEvaluationHorizons();
