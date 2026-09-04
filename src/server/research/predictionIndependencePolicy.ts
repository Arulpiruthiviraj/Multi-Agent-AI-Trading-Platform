/**
 * Per-agent independence policy for prediction/outcome clustering.
 *
 * ARGUS_PREDICTIVE_EDGE_FORENSIC_AUDIT.md (M3) found a single universal clustering rule is not
 * appropriate for every agent - Kronos's own natural forecast horizon is much shorter than the
 * generic 60-minute evaluation window, QuantEngine's strategy-sourced ideas and its cold-start
 * regime-only bootstrap idea are different signal sources that should never be pooled into one
 * statistic, and PortfolioManager's risk-exit ideas are not directional-alpha calls at all (see
 * ARGUS_INDEPENDENT_LEARNING_AND_REGIME_IMPLEMENTATION_AUDIT.md Phase 9). This module is
 * deliberately a small set of resolver functions, not a class-per-agent abstraction - reuse over
 * new architecture, per that audit's own "do not overengineer" instruction.
 */
import { tradingSafety } from '../config/tradingSafety';
import { agentWeightConfig } from '../config/agentWeights';
import { evaluationHorizons } from '../config/evaluationHorizons';

/** Time-gap threshold (ms) for clustering this agent's own predictions into independent observations. */
export function independenceClusterGapMs(agentName: string): number {
  if (agentName === 'KronosEngine') return tradingSafety.kronosEvaluationHorizonMs;
  return tradingSafety.evaluationHorizonMs;
}

/**
 * Evaluation-horizon-mismatch remediation (2026-09-04): the actual WIN/LOSS grading window
 * PredictionOutcomeEvaluator.ts uses, resolved per agent (and, for QuantEngine, per real
 * underlying strategy via the SAME secondaryGroupKey() extraction already used for independence
 * clustering) - see config/evaluationHorizons.json's own $comment for why a single universal
 * 60-minute clock was wrong for every source. KronosEngine keeps its own dedicated
 * kronosEvaluationHorizonMs, unchanged, resolved by the caller before this function is ever
 * reached (mirrors independenceClusterGapMs's own Kronos special-case).
 */
export function resolveEvaluationHorizonMs(agentName: string, reasoning: string | null | undefined): number {
  if (agentName === 'QuantEngine') {
    const rawKey = secondaryGroupKey(agentName, reasoning);
    const strategyId = rawKey ? rawKey.replace(/__COLD_START_BOOTSTRAP$/, '') : null;
    if (strategyId && evaluationHorizons.byQuantStrategyId[strategyId] != null) {
      return evaluationHorizons.byQuantStrategyId[strategyId];
    }
  }
  return evaluationHorizons.byAgentName[agentName] ?? tradingSafety.evaluationHorizonMs;
}

/**
 * Risk-exit ideas (PortfolioManager's TARGET_REACHED/STOP_LOSS/invalidation exits) are not
 * directional-alpha predictions - ChiefTrader already treats them as a separate, confidence-
 * agnostic approval path (isRiskExit(), skips debate/min-agents). Letting their accuracy move a
 * learned "directional call quality" weight the same way TechnicalAgent's does would conflate two
 * different questions. Their raw/effective stats are still computed and exposed (never hidden) -
 * only the LIVE WEIGHT LEARNING loop excludes them, staying pinned at the neutral default.
 */
export function isExcludedFromWeightLearning(agentName: string): boolean {
  return agentName === agentWeightConfig.riskExitAgent;
}

/**
 * Best-effort secondary grouping key beyond (symbol, side) for agents whose reasoning text
 * encodes a real sub-identity that should not be pooled together. QuantEngine's strategy-sourced
 * ideas embed "QuantEngine/<STRATEGY>: ..." (StrategyEngine.ts's bestStrategyIdea reasoning
 * format); its cold-start bootstrap idea is a structurally different, EV-free signal source
 * (QuantSignalAgent.ts) and must never share a statistic with EV-backed strategy ideas. Returns
 * null when no agent-specific sub-identity applies (the default (symbol, side) grouping already
 * used by effectiveSampleSize.ts is sufficient for every other agent).
 *
 * Real defect fixed (Phase 10, 2026-08-31 "why is QuantEngine 100% COLD_START_BOOTSTRAP"
 * investigation): QuantSignalAgent.ts's cold-start path already names the REAL underlying named
 * strategy that triggered it right in the reasoning text - "Cold-start bootstrap: MOMENTUM_BREAKOUT
 * is COLD_START (zero real closed trades)..." - but this function used to check for the bootstrap
 * phrase FIRST and return the same generic 'COLD_START_BOOTSTRAP' key regardless of which real
 * strategy was actually behind it. Since ARGUS has zero organic closed trades to date (every named
 * strategy is honestly COLD_START today - not a bug, just the real, current state), EVERY
 * strategy-sourced idea has gone through this exact bootstrap path, permanently erasing which real
 * strategy produced it before a single observation was ever logged - a genuine circular dependency
 * (a strategy needs its own graded track record to escape bootstrap mode, but bootstrap mode never
 * let it keep one). Extracting the real strategy name now (still honestly suffixed, never conflated
 * with an EV-backed observation of the same strategy) lets each named strategy start accumulating
 * its OWN attributable evidence as bootstrap trades resolve, instead of all of them forever sharing
 * one undifferentiated bucket.
 */
export function secondaryGroupKey(agentName: string, reasoning: string | null | undefined): string | null {
  if (agentName !== 'QuantEngine' || !reasoning) return null;
  if (reasoning.includes('Cold-start bootstrap')) {
    const namedStrategy = /Cold-start bootstrap:\s*([A-Z0-9_]+)\s+is\s/.exec(reasoning);
    return namedStrategy ? `${namedStrategy[1]}__COLD_START_BOOTSTRAP` : 'COLD_START_BOOTSTRAP';
  }
  const match = /QuantEngine\/([A-Z0-9_]+):/.exec(reasoning);
  return match ? match[1] : null;
}
