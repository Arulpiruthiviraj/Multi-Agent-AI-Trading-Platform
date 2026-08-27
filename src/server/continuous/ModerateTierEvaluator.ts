/**
 * Phase 7E/7H (MODERATE consensus tier, 2026-08-27). Additive, PAPER-only, default-OFF
 * (CONSENSUS_MODERATE_TIER_ENABLED). Never imports RiskEngine, OMS, or BrokerManager - it only
 * decides whether ChiefTraderAgent.ts's existing NO-TRADE-on-low-confidence branch should instead
 * approve as MODERATE, using strictly MORE evidence than the STRONG path requires, never less:
 * the same independent-agent floor and the same hard-veto checks (debate HOLD, bear-case HOLD, AI
 * contradiction) the STRONG path already computes, PLUS a NEW per-agent calibration-trust gate that
 * the STRONG path does not have.
 *
 * Numeric-policy note (Phase 1 of this mission, real-data finding as of 2026-08-27): querying the
 * live CalibrationCandidateBuilder output across all 25 tracked (agent, bucket) pairs, sorted by
 * effective (cluster-corrected) sample size, shows NO bucket with a materially large effective N
 * sitting at a statistically-significant win rate above chance (every Wilson lower bound is at or
 * below 0.5) - including QuantEngine's 0.6-0.7 bucket, previously characterized as "well-calibrated"
 * from its RAW win rate (60.2%, n=249) but which collapses to effective N=11 / 18.2% once correctly
 * clustered by symbol+side+strategy. Given this, the honest expectation is that
 * isAgentBucketCalibrationTrustworthy() below returns false for every agent/bucket pair TODAY, so
 * the MODERATE tier is expected to approve zero ideas until real evidence changes that - this is the
 * gate working as designed, not a defect. `moderateMinConfidence` (config/tradingSafety.json,
 * currently 0.6) is a POLICY parameter, not an empirically-proven optimum: it is set to
 * ConfidenceCalibration.ts's own CONFIDENCE_BUCKETS[1].low (== debateTriggerConfidence ==
 * minStrategyConfidenceToTrade elsewhere in this codebase) specifically so the MODERATE band never
 * straddles two different calibration buckets, which would otherwise make "which bucket's champion
 * do I check" ambiguous for a single evaluation.
 */
import { bucketFor } from '../services/ConfidenceCalibration';
import { calibrationVersionType } from './CalibrationCandidateBuilder';
import { getChampion } from './ChampionChallengerService';
import { tradingSafety } from '../config/tradingSafety';
import { isConsensusModerateTierEnabled } from '../config/tradingSafety';

export interface AgentCalibrationTrust {
  agent: string;
  rawConfidence: number;
  trustworthy: boolean;
  championEffectiveN: number | null;
  reason: string;
}

/**
 * True only when a statistically-validated CHAMPION exists for this exact (agent, confidence
 * bucket) pair - i.e. CalibrationCandidateBuilder's runCalibrationValidationCycle has both cleared
 * the effective-sample-size floor AND the Wilson-lower-bound-above-chance bar for it. Reads only
 * the observational learning_versions ledger; never touches agent_confidence_calibration.
 */
export async function isAgentBucketCalibrationTrustworthy(agent: string, rawConfidence: number): Promise<AgentCalibrationTrust> {
  const bucket = bucketFor(rawConfidence);
  const versionType = calibrationVersionType(agent, bucket);
  try {
    const champion = await getChampion(versionType);
    if (champion) {
      return {
        agent, rawConfidence, trustworthy: true, championEffectiveN: champion.sampleSize,
        reason: `Statistically-validated calibration champion exists for ${agent}'s ${bucket.low}-${bucket.high} bucket (effective N=${champion.sampleSize}).`,
      };
    }
    return {
      agent, rawConfidence, trustworthy: false, championEffectiveN: null,
      reason: `No statistically-validated calibration champion yet for ${agent}'s ${bucket.low}-${bucket.high} bucket (insufficient effective sample size, or effective win rate not above chance).`,
    };
  } catch (e) {
    return {
      agent, rawConfidence, trustworthy: false, championEffectiveN: null,
      reason: `Calibration-trust lookup failed for ${agent}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export interface ModerateTierEligibilityParams {
  side: string;
  confidence: number;
  enoughIndependentVoices: boolean;
  debateSaidHold: boolean;
  bearSaidHold: boolean;
  aiContradicts: boolean;
  /** Raw (pre-calibration) confidence per agreeing agent - the calibration-trust bucket lookup must use the same raw bucketing calibrateConfidence() itself uses. */
  agreeingAgents: Array<{ agent: string; rawConfidence: number }>;
}

export interface ModerateTierEligibility {
  eligible: boolean;
  reasonCode:
    | 'MODERATE_TIER_DISABLED'
    | 'MODERATE_REJECT_LOW_CONFIDENCE'
    | 'MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE'
    | 'MODERATE_REJECT_HARD_VETO'
    | 'MODERATE_REJECT_UNTRUSTED_CALIBRATION'
    | 'MODERATE_APPROVED';
  reason: string;
  calibrationDetails: AgentCalibrationTrust[];
}

/**
 * Evaluates whether an idea that already FAILED the STRONG (>= consensusApprovalThreshold) check
 * qualifies for MODERATE approval instead. Every check here is either identical to (independent
 * voices, hard vetoes) or strictly additional to (calibration trust) what the STRONG path already
 * requires - this function can only ever be MORE conservative than STRONG, never less.
 */
export async function evaluateModerateTierEligibility(params: ModerateTierEligibilityParams): Promise<ModerateTierEligibility> {
  if (!isConsensusModerateTierEnabled()) {
    return { eligible: false, reasonCode: 'MODERATE_TIER_DISABLED', reason: 'CONSENSUS_MODERATE_TIER_ENABLED is not set to true.', calibrationDetails: [] };
  }
  if (params.side === 'HOLD' || params.confidence < tradingSafety.moderateMinConfidence) {
    return {
      eligible: false, reasonCode: 'MODERATE_REJECT_LOW_CONFIDENCE',
      reason: `Confidence ${(params.confidence * 100).toFixed(1)}% is below the MODERATE floor ${(tradingSafety.moderateMinConfidence * 100).toFixed(0)}%.`,
      calibrationDetails: [],
    };
  }
  if (!params.enoughIndependentVoices) {
    return {
      eligible: false, reasonCode: 'MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE',
      reason: 'Fewer independent agreeing agents than minIndependentAgreeingAgents requires - the same floor the STRONG path enforces.',
      calibrationDetails: [],
    };
  }
  if (params.debateSaidHold || params.bearSaidHold || params.aiContradicts) {
    return {
      eligible: false, reasonCode: 'MODERATE_REJECT_HARD_VETO',
      reason: 'A hard-veto condition (adversarial debate HOLD, bear-case HOLD, or AI contradiction) is active - respected identically to the STRONG path.',
      calibrationDetails: [],
    };
  }

  const calibrationDetails = await Promise.all(
    params.agreeingAgents.map((a) => isAgentBucketCalibrationTrustworthy(a.agent, a.rawConfidence)),
  );
  const allTrustworthy = calibrationDetails.length > 0 && calibrationDetails.every((d) => d.trustworthy);
  if (!allTrustworthy) {
    return {
      eligible: false, reasonCode: 'MODERATE_REJECT_UNTRUSTED_CALIBRATION',
      reason: 'At least one participating agent lacks a statistically-validated (effective-N and above-chance) calibration champion for its current confidence bucket.',
      calibrationDetails,
    };
  }

  return {
    eligible: true, reasonCode: 'MODERATE_APPROVED',
    reason: 'All MODERATE-tier gates passed: independent-agent floor met, no hard veto active, every participating agent has a statistically-validated calibration champion for its bucket.',
    calibrationDetails,
  };
}
