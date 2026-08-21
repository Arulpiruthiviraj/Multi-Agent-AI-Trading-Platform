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

/** Time-gap threshold (ms) for clustering this agent's own predictions into independent observations. */
export function independenceClusterGapMs(agentName: string): number {
  if (agentName === 'KronosEngine') return tradingSafety.kronosEvaluationHorizonMs;
  return tradingSafety.evaluationHorizonMs;
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
 */
export function secondaryGroupKey(agentName: string, reasoning: string | null | undefined): string | null {
  if (agentName !== 'QuantEngine' || !reasoning) return null;
  if (reasoning.includes('Cold-start bootstrap')) return 'COLD_START_BOOTSTRAP';
  const match = /QuantEngine\/([A-Z0-9_]+):/.exec(reasoning);
  return match ? match[1] : null;
}
