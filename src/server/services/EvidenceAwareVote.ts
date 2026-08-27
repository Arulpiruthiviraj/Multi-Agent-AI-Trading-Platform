/**
 * Phase 4B (Evidence-Aware Consensus, SHADOW MODE ONLY, 2026-08-26).
 *
 * Real defects found and evidenced by the 2026-08-26 zero-trade audit:
 *  1. ChiefTraderAgent.calibrateConfidence() (ChiefTraderAgent.ts:529) maps a raw confidence
 *     number to a historically-calibrated one keyed only on (agentName, confidenceBucket) - it
 *     has no knowledge of *why* the confidence was low. A genuine DATA_UNAVAILABLE vote (raw
 *     confidence 0, e.g. FundamentalAgent when AlphaVantage's daily budget is exhausted) can be
 *     silently recalibrated to a non-zero confidence (observed: 0 -> 0.532) purely because that
 *     agent has historically been ~53% accurate whenever it reports near-zero confidence for ANY
 *     reason. That recalibrated number then participates in EvidenceAggregator's weighted math
 *     indistinguishably from a genuine low-conviction analytical HOLD.
 *  2. ChiefTraderAgent's debate handler (ChiefTraderAgent.ts:410-434) collapses AIRouter.
 *     routeConsensus()'s real per-model results (each with a real decision + 0-100 confidence -
 *     see AIRouter.ts routeConsensus()'s buyWeight/sellWeight math) into a binary step function:
 *     tradingSafety.debateResultConfidence (0.8) flat if >=2 models succeeded, or that times
 *     debateSingleModelConfidencePenalty (0.56) if exactly 1 did. A 51/49 split debate and a
 *     unanimous 95%-confidence bearish debate both surface as identical 0.8-confidence HOLD votes.
 *
 * This module is a SHADOW-ONLY, read-only re-classification and alternative aggregation. It is
 * NEVER wired into the live decision (ChiefTraderAgent's real `approved`/`reason`/`approvedSide`
 * computation is completely unchanged) - it only computes a parallel, explainable "what would an
 * evidence-aware model have concluded" result for comparison and persistence
 * (ConsensusModelComparison.ts), per Phase 4 Part 2's "do not replace the engine until runtime
 * evidence supports it" requirement. Does not touch consensusApprovalThreshold,
 * minIndependentAgreeingAgents, RiskEngine, position sizing, OMS, or the kill switch.
 */
import type { Evidence } from './EvidenceAggregator';

export type EvidenceState =
  | 'BULLISH'
  | 'BEARISH'
  | 'NEUTRAL'
  | 'UNCERTAIN'
  | 'DATA_UNAVAILABLE'
  | 'MODEL_FAILED'
  | 'STALE';

export interface EvidenceAwareVote {
  agent: string;
  side: 'BUY' | 'SELL' | 'HOLD';
  /** The confidence EvidenceAggregator actually received (post-calibration for calibrated agents). */
  confidence: number;
  evidenceState: EvidenceState;
  /** 0-1. How much this vote should actually count, independent of its raw confidence number. */
  evidenceQuality: number;
  dataAvailable: boolean;
  /** False votes are reported but excluded from the shadow aggregate's denominator entirely. */
  usableForConsensus: boolean;
  reasonCode: string;
  provenance: {
    source: string;
    reasoning: string;
  };
}

/** Below this raw confidence, a genuine (data-available) HOLD is classified UNCERTAIN rather than
 *  NEUTRAL - a deliberate, named threshold (not a magic number scattered through the aggregation). */
const UNCERTAIN_CONFIDENCE_CEILING = 0.35;

const DATA_UNAVAILABLE_MARKERS = ['DATA_UNAVAILABLE', 'rate limit exhausted', 'no routable AI provider'];
const MODEL_FAILED_MARKERS = ['fail-closed', 'routeConsensus threw', 'no verdict', '0 of', 'no usable verdict'];

function reasoningMatches(reasoning: string, markers: string[]): boolean {
  const lower = reasoning.toLowerCase();
  return markers.some((m) => lower.includes(m.toLowerCase()));
}

/**
 * Re-classifies one already-aggregated Evidence row (post-calibration) into its true evidence
 * state, using the ORIGINAL reasoning text (calibration only ever overwrites the confidence
 * number, never the reasoning string - see ChiefTraderAgent.ts:571) to detect a DATA_UNAVAILABLE
 * or MODEL_FAILED vote regardless of what confidence value it was recalibrated to.
 */
export function classifyVote(evidence: Evidence): EvidenceAwareVote {
  const reasoning = evidence.reasoning || '';

  if (reasoningMatches(reasoning, DATA_UNAVAILABLE_MARKERS)) {
    return {
      agent: evidence.agent, side: evidence.side, confidence: evidence.confidence,
      evidenceState: 'DATA_UNAVAILABLE', evidenceQuality: 0, dataAvailable: false,
      usableForConsensus: false,
      reasonCode: 'DATA_UNAVAILABLE_CALIBRATION_OVERRIDE_IGNORED',
      provenance: { source: evidence.agent, reasoning },
    };
  }

  if (evidence.agent === 'ConsensusDebate' && reasoningMatches(reasoning, MODEL_FAILED_MARKERS)) {
    return {
      agent: evidence.agent, side: evidence.side, confidence: evidence.confidence,
      evidenceState: 'MODEL_FAILED', evidenceQuality: 0, dataAvailable: false,
      usableForConsensus: false,
      reasonCode: 'DEBATE_FAIL_CLOSED_NOT_REAL_EVIDENCE',
      provenance: { source: evidence.agent, reasoning },
    };
  }

  if (evidence.side === 'BUY' || evidence.side === 'SELL') {
    return {
      agent: evidence.agent, side: evidence.side, confidence: evidence.confidence,
      evidenceState: evidence.side === 'BUY' ? 'BULLISH' : 'BEARISH',
      evidenceQuality: evidence.confidence, dataAvailable: true, usableForConsensus: true,
      reasonCode: evidence.side === 'BUY' ? 'DIRECTIONAL_BULLISH' : 'DIRECTIONAL_BEARISH',
      provenance: { source: evidence.agent, reasoning },
    };
  }

  // HOLD, genuinely data-available.
  const uncertain = evidence.confidence < UNCERTAIN_CONFIDENCE_CEILING;
  return {
    agent: evidence.agent, side: 'HOLD', confidence: evidence.confidence,
    evidenceState: uncertain ? 'UNCERTAIN' : 'NEUTRAL',
    evidenceQuality: evidence.confidence, dataAvailable: true, usableForConsensus: true,
    reasonCode: uncertain ? 'WEAK_HOLD_NOT_A_VETO' : 'GENUINE_NO_EDGE',
    provenance: { source: evidence.agent, reasoning },
  };
}

export interface DebateModelResult {
  decision?: 'BUY' | 'SELL' | 'HOLD' | string;
  confidence?: number; // 0-100, as returned by AIRouter.routeConsensus
  status?: string;
}

export interface DebateMarginResult {
  evidenceState: EvidenceState;
  /** 0-1. Real margin between the winning and runner-up side, from actual per-model weights. */
  marginStrength: number;
  /** 0-1. Mean confidence of models that actually succeeded, normalized from the 0-100 scale. */
  avgConfidence: number;
  successCount: number;
  attemptedCount: number;
  /** Scaled confidence (0-1) for shadow use only - never written to the live debateResultConfidence path. */
  shadowConfidence: number;
}

/**
 * Real margin math from AIRouter.routeConsensus()'s own per-model results (real decision + real
 * 0-100 confidence per provider - see AIRouter.ts routeConsensus()). Never fabricates a margin the
 * providers didn't expose: if there are zero successful results, this reports MODEL_FAILED with
 * shadowConfidence 0, not an invented number.
 */
export function computeDebateMarginFromResults(results: DebateModelResult[]): DebateMarginResult {
  const attempted = results.length;
  const successful = results.filter((r) => r.status === 'success' && typeof r.confidence === 'number');

  if (successful.length === 0) {
    return {
      evidenceState: 'MODEL_FAILED', marginStrength: 0, avgConfidence: 0,
      successCount: 0, attemptedCount: attempted, shadowConfidence: 0,
    };
  }

  let buyWeight = 0, sellWeight = 0, holdWeight = 0;
  let confidenceSum = 0;
  for (const r of successful) {
    const c = Math.max(0, Math.min(100, r.confidence ?? 0));
    confidenceSum += c;
    if (r.decision === 'BUY') buyWeight += c;
    else if (r.decision === 'SELL') sellWeight += c;
    else holdWeight += c;
  }
  const totalWeight = buyWeight + sellWeight + holdWeight;
  const avgConfidence = confidenceSum / successful.length / 100;

  const weights = [buyWeight, sellWeight, holdWeight].sort((a, b) => b - a);
  const marginStrength = totalWeight > 0 ? (weights[0] - weights[1]) / totalWeight : 0;

  let evidenceState: EvidenceState;
  if (marginStrength < 0.25) {
    evidenceState = 'UNCERTAIN';
  } else if (buyWeight === Math.max(buyWeight, sellWeight, holdWeight)) {
    evidenceState = 'BULLISH';
  } else if (sellWeight === Math.max(buyWeight, sellWeight, holdWeight)) {
    evidenceState = 'BEARISH';
  } else {
    evidenceState = 'NEUTRAL';
  }

  // Scaled by real margin strength, real average confidence, and absolute sample size (not
  // success RATE - 1-of-1 and 2-of-2 both have a 100% success rate but are not equally strong
  // corroboration). Saturates at 2 successful models, matching this codebase's own existing
  // "at least 2 independent voices" reasoning (minIndependentAgreeingAgents) rather than treating
  // a lone model's confident verdict as equivalent to two models agreeing.
  const sampleSizeFactor = Math.min(1, successful.length / 2);
  const shadowConfidence = Math.max(0, Math.min(1, marginStrength * avgConfidence * sampleSizeFactor));

  return { evidenceState, marginStrength, avgConfidence, successCount: successful.length, attemptedCount: attempted, shadowConfidence };
}

export interface ShadowConsensusResult {
  finalDecision: 'BUY' | 'SELL' | 'HOLD';
  aggregateConfidence: number;
  bullishEvidence: number;
  bearishEvidence: number;
  uncertainty: number;
  excludedAgents: Array<{ agent: string; reason: string }>;
  reasonCode: string;
}

/**
 * Alternative aggregation over the SAME evidence ChiefTraderAgent already has, honoring the
 * "critical rule": a vote with usableForConsensus === false is excluded from the denominator
 * entirely, not folded in as a disguised HOLD. Weights are the SAME per-agent weights
 * ChiefTraderAgent.resolveWeight() already resolves (passed in by the caller) - this does not
 * invent a new weighting scheme, only a different way of deciding which votes count at all.
 */
export function computeShadowConsensus(
  votes: EvidenceAwareVote[],
  weights: Record<string, number>,
  approvalThreshold: number,
): ShadowConsensusResult {
  const usable = votes.filter((v) => v.usableForConsensus);
  const excludedAgents = votes
    .filter((v) => !v.usableForConsensus)
    .map((v) => ({ agent: v.agent, reason: v.reasonCode }));

  // Directional (BULLISH/BEARISH) and non-directional (NEUTRAL/UNCERTAIN) weight are tracked in
  // SEPARATE denominators - a "no edge" vote is not evidence against the trade, it is an agent
  // with no directional thesis at all, so it must not dilute the bullish/bearish ratio the way a
  // real opposing vote would (this is exactly Part B's Case D: "a weak HOLD should not
  // automatically behave like a high-confidence veto"). Real opposition can only come from an
  // actual BEARISH (SELL-side) vote.
  let bullishWeighted = 0;
  let bearishWeighted = 0;
  let directionalWeight = 0;
  let nonDirectionalWeight = 0;
  let totalUsableWeight = 0;

  for (const v of usable) {
    const w = weights[v.agent] ?? 1;
    totalUsableWeight += w;
    if (v.evidenceState === 'BULLISH') {
      bullishWeighted += v.confidence * w;
      directionalWeight += w;
    } else if (v.evidenceState === 'BEARISH') {
      bearishWeighted += v.confidence * w;
      directionalWeight += w;
    } else {
      nonDirectionalWeight += w; // NEUTRAL / UNCERTAIN
    }
  }

  const bullishEvidence = directionalWeight > 0 ? bullishWeighted / directionalWeight : 0;
  const bearishEvidence = directionalWeight > 0 ? bearishWeighted / directionalWeight : 0;
  const uncertainty = totalUsableWeight > 0 ? nonDirectionalWeight / totalUsableWeight : 1;

  let finalDecision: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  let aggregateConfidence = 0;
  let reasonCode = 'NO_USABLE_EVIDENCE';

  if (usable.length === 0) {
    reasonCode = 'NO_USABLE_EVIDENCE';
  } else if (bullishEvidence > bearishEvidence && bullishEvidence > approvalThreshold) {
    finalDecision = 'BUY';
    aggregateConfidence = bullishEvidence;
    reasonCode = 'BULLISH_EVIDENCE_CLEARS_THRESHOLD';
  } else if (bearishEvidence > bullishEvidence && bearishEvidence > approvalThreshold) {
    finalDecision = 'SELL';
    aggregateConfidence = bearishEvidence;
    reasonCode = 'BEARISH_EVIDENCE_CLEARS_THRESHOLD';
  } else if (Math.max(bullishEvidence, bearishEvidence) <= approvalThreshold && uncertainty > 0.5) {
    aggregateConfidence = Math.max(bullishEvidence, bearishEvidence);
    reasonCode = 'INSUFFICIENT_CONVICTION';
  } else {
    aggregateConfidence = Math.max(bullishEvidence, bearishEvidence);
    reasonCode = 'INSUFFICIENT_CONVICTION';
  }

  return { finalDecision, aggregateConfidence, bullishEvidence, bearishEvidence, uncertainty, excludedAgents, reasonCode };
}
