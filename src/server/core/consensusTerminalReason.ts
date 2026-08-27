/**
 * Phase 9I ("Why No Trade?" diagnostic, 2026-08-27). Pure relabeling of the SAME branches
 * ChiefTraderAgent.ts's evaluateConsensusSerialized() ladder already computes - no new decision
 * logic, no new veto, no new approval path. Gives every consensus round exactly one machine-
 * readable terminal reason code alongside its existing free-text `reason` string, so CLI/UI/API
 * consumers do not have to regex-parse prose to answer "why didn't this trade?".
 *
 * Scope: this only covers what ChiefTraderAgent can determine about ITS OWN decision. Downstream
 * stages (RiskEngine's 24 gates, OMS, the broker) already record their own faithful status
 * (risk_assessments.approved/rejection_gate, trades.status, fills existence) - this does not
 * duplicate or override those; a full round-trip "why no trade" reconstruction layers this code on
 * top of that existing downstream data, it does not replace it.
 */

export type ConsensusTerminalReasonCode =
  | 'CONSENSUS_APPROVED'
  | 'AGENT_HOLD'
  | 'AGENT_DATA_UNAVAILABLE'
  | 'CONFIDENCE_BELOW_STRONG'
  | 'INSUFFICIENT_AGENT_PARTICIPATION'
  | 'HARD_VETO'
  | 'MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE'
  | 'MODERATE_REJECT_CALIBRATION'
  | 'MODERATE_REJECT_LOW_CONFIDENCE'
  | 'MODERATE_TIER_DISABLED';

export interface TerminalReasonClassificationInput {
  approved: boolean;
  side: string;
  confidence: number;
  strongThreshold: number;
  enoughIndependentVoices: boolean;
  debateSaidHold: boolean;
  bearSaidHold: boolean;
  aiContradicts: boolean;
  /** True when the winning evidence itself is a HOLD whose reasoning names missing/unavailable data (e.g. FundamentalAgent/MacroAgent's DATA_UNAVAILABLE HOLDs winning the round outright). */
  holdIsDataUnavailable: boolean;
  moderateReasonCode?: string;
}

export function classifyConsensusTerminalReason(input: TerminalReasonClassificationInput): ConsensusTerminalReasonCode {
  if (input.approved) return 'CONSENSUS_APPROVED';

  if (input.side === 'HOLD') {
    return input.holdIsDataUnavailable ? 'AGENT_DATA_UNAVAILABLE' : 'AGENT_HOLD';
  }

  if (input.confidence <= input.strongThreshold) {
    if (input.moderateReasonCode === 'MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE') return 'MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE';
    if (input.moderateReasonCode === 'MODERATE_REJECT_UNTRUSTED_CALIBRATION') return 'MODERATE_REJECT_CALIBRATION';
    if (input.moderateReasonCode === 'MODERATE_REJECT_LOW_CONFIDENCE') return 'MODERATE_REJECT_LOW_CONFIDENCE';
    if (input.moderateReasonCode === 'MODERATE_TIER_DISABLED') return 'MODERATE_TIER_DISABLED';
    if (input.moderateReasonCode === 'MODERATE_REJECT_HARD_VETO') return 'HARD_VETO';
    return 'CONFIDENCE_BELOW_STRONG';
  }

  if (!input.enoughIndependentVoices) return 'INSUFFICIENT_AGENT_PARTICIPATION';
  if (input.debateSaidHold || input.bearSaidHold || input.aiContradicts) return 'HARD_VETO';

  return 'CONFIDENCE_BELOW_STRONG';
}
