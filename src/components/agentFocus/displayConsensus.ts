/**
 * Client-side reconstruction of EvidenceAggregator.netConfidenceFromVotes using the same
 * config/tradingSafety.json disagreementPenalty. Does not import server modules (fs loader).
 * Official approval still comes from CHIEF_CONSENSUS_COMPLETED — this is for stacking live
 * TRADE_IDEA_GENERATED payloads before that event arrives. Calibration is server-only and
 * is not applied here.
 */
import tradingSafety from '../../../config/tradingSafety.json';
import agentWeights from '../../../config/agentWeights.json';

export function displayNetConfidenceFromVotes(
  agreeing: Array<{ confidence: number; weight: number }>,
  disagreeing: Array<{ confidence: number; weight: number }>,
): number {
  const penalty = tradingSafety.disagreementPenalty;
  let weightedConfidence = 0;
  let totalWeight = 0;
  for (const e of agreeing) {
    weightedConfidence += e.confidence * e.weight;
    totalWeight += e.weight;
  }
  for (const e of disagreeing) {
    weightedConfidence -= e.confidence * e.weight * penalty;
    totalWeight += e.weight;
  }
  return Math.max(0, Math.min(1, weightedConfidence / (totalWeight || 1)));
}

export function resolveDisplayWeight(
  agentName: string,
  liveWeights: { agentName: string; currentWeight: number | null }[],
): number {
  const live = liveWeights.find((w) => w.agentName === agentName);
  if (live && typeof live.currentWeight === 'number' && Number.isFinite(live.currentWeight)) {
    return live.currentWeight;
  }
  if (agentName === 'ConsensusDebate') return agentWeights.consensusDebateWeight;
  const listed = (agentWeights.defaults as Record<string, number>)[agentName];
  if (typeof listed === 'number' && Number.isFinite(listed)) return listed;
  return agentWeights.unlistedAgentWeight;
}

export const CONSENSUS_APPROVAL_THRESHOLD = tradingSafety.consensusApprovalThreshold;
export const DISAGREEMENT_PENALTY = tradingSafety.disagreementPenalty;

/** Numerator / denominator of the same fraction EvidenceAggregator uses. */
export function displayVoteTerms(
  agreeing: Array<{ confidence: number; weight: number }>,
  disagreeing: Array<{ confidence: number; weight: number }>,
): { weightedSum: number; totalWeight: number; net: number } {
  const penalty = tradingSafety.disagreementPenalty;
  let weightedSum = 0;
  let totalWeight = 0;
  for (const e of agreeing) {
    weightedSum += e.confidence * e.weight;
    totalWeight += e.weight;
  }
  for (const e of disagreeing) {
    weightedSum -= e.confidence * e.weight * penalty;
    totalWeight += e.weight;
  }
  const den = totalWeight || 1;
  return {
    weightedSum,
    totalWeight: den,
    net: Math.max(0, Math.min(1, weightedSum / den)),
  };
}
