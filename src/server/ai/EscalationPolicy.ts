/**
 * ==========================================================
 * Module: EscalationPolicy
 *
 * Purpose:
 * A real, pure, independently-testable local-first escalation decision. Given a local model's
 * signal (or absence of one), decides whether a caller should still escalate to a more expensive
 * reasoning model - and always returns a concrete reason, so every escalation (or skip) is
 * explainable, not just a threshold silently applied. Callers own the actual escalation call
 * (this module makes no network/AI calls itself).
 * ==========================================================
 */

import { tradingSafety } from '../config/tradingSafety';

export interface EscalationInput {
  localSource: string;      // e.g. 'finbert'
  localSignalAvailable: boolean;
  localConfidence: number;  // 0-1 magnitude - callers pass abs(signedScore) or similar, not a raw signed value
  decisiveThreshold: number; // 0-1 - local confidence at/above this is treated as decisive
}

export interface EscalationDecision {
  escalate: boolean;
  reason: string;
}

export function decideEscalation(input: EscalationInput): EscalationDecision {
  if (!input.localSignalAvailable) {
    return { escalate: true, reason: `${input.localSource} unavailable - no local signal to decide from` };
  }
  if (input.localConfidence >= input.decisiveThreshold) {
    return {
      escalate: false,
      reason: `${input.localSource} signal decisive (confidence ${input.localConfidence.toFixed(2)} >= threshold ${input.decisiveThreshold.toFixed(2)})`,
    };
  }
  return {
    escalate: true,
    reason: `${input.localSource} signal inconclusive (confidence ${input.localConfidence.toFixed(2)} < threshold ${input.decisiveThreshold.toFixed(2)})`,
  };
}

/**
 * OpenAlice escalation trigger (OPENALICE_INTEGRATION_AUDIT.md Phase 3).
 *
 * OpenAlice is a slow (minutes, not seconds), non-blocking, independent second opinion - it is
 * never on the critical path of an actual order. So this is NOT "should we escalate before
 * deciding" (that's decideEscalation above); it's "is this approved idea interesting/uncertain
 * enough to be worth a real independent check for FUTURE decisions." Firing it for every trade
 * would just be noise (and cost, and OpenAlice-side load) - it should fire only where an
 * independent read is most likely to add information:
 *  - confidence sits in a band where Chief's approval was real but not overwhelming, OR
 *  - EvidenceAggregator recorded real agent disagreement even though the weighted vote still
 *    crossed the approval bar.
 */
export interface OpenAliceTriggerInput {
  confidence: number;      // 0-1, ChiefTraderAgent's approved weighted confidence
  disagreementCount: number; // evidence.disagreements.length from EvidenceAggregator
  lowerBound?: number;
  upperBound?: number;
}

export interface OpenAliceTriggerDecision {
  shouldVerify: boolean;
  reason: string;
}

export function shouldTriggerOpenAliceVerification(input: OpenAliceTriggerInput): OpenAliceTriggerDecision {
  const lowerBound = input.lowerBound ?? tradingSafety.openAliceUncertainBandLow;
  const upperBound = input.upperBound ?? tradingSafety.openAliceUncertainBandHigh;

  if (input.disagreementCount > 0) {
    return {
      shouldVerify: true,
      reason: `${input.disagreementCount} agent(s) disagreed despite the weighted approval - worth an independent read`,
    };
  }
  if (input.confidence >= lowerBound && input.confidence <= upperBound) {
    return {
      shouldVerify: true,
      reason: `confidence ${input.confidence.toFixed(2)} is in the uncertain band [${lowerBound}, ${upperBound}] - not overwhelming consensus`,
    };
  }
  return {
    shouldVerify: false,
    reason: `confidence ${input.confidence.toFixed(2)} outside uncertain band and no agent disagreement - independent check unlikely to add information`,
  };
}
