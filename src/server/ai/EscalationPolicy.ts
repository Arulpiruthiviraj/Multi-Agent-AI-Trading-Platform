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
