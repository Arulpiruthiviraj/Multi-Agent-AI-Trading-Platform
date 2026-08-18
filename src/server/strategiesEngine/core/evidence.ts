/**
 * ==========================================================
 * Module: strategiesEngine/core/evidence
 *
 * Purpose:
 * The real evidence-state ladder every strategy definition sits on. A strategy in the registry is
 * a CANDIDATE, never a claim of profitability - `EvidenceState` and `promoteEvidence()` are the
 * mechanism that keeps that true: promotion is fail-closed (one real rung at a time, never a
 * skip-ahead to LIVE_ELIGIBLE) and every transition is meant to be recorded by the caller as an
 * audit row (schema.strategyEnginePromotions), not silently mutated in place.
 *
 * This module makes no live-trading decision by itself - reaching LIVE_ELIGIBLE here means only
 * "this strategy's own evidence ladder is complete." It does NOT unlock live trading; Argus's
 * existing live-readiness engine (docs/ARGUS.md: LIVE is NO-GO) remains the sole authority over
 * whether ANY order can ever be placed, strategy-engine-sourced or not.
 * ==========================================================
 */

export type EvidenceState =
  | 'UNTESTED'
  | 'EXPERIMENTAL'
  | 'BACKTESTED'
  | 'OOS_TESTED'
  | 'WFO_TESTED'
  | 'ROBUST'
  | 'PAPER_VALIDATED'
  | 'LIVE_ELIGIBLE';

/** The real, ordered ladder - index is the only thing that matters for "is this a valid forward
 *  step," not the string values themselves. */
export const EVIDENCE_LADDER: EvidenceState[] = [
  'UNTESTED', 'EXPERIMENTAL', 'BACKTESTED', 'OOS_TESTED', 'WFO_TESTED', 'ROBUST', 'PAPER_VALIDATED', 'LIVE_ELIGIBLE',
];

export const DEFAULT_EVIDENCE_STATE: EvidenceState = 'EXPERIMENTAL';

export interface EvidenceDerivedFlags {
  experimental: boolean;
  validated: boolean; // BACKTESTED or later
  promotable: boolean; // ROBUST or later - has cleared enough real evidence to be considered for paper
  liveEligible: boolean; // exactly LIVE_ELIGIBLE
}

/** The four booleans the build directive's Section 6 describes, derived from one real state
 *  rather than kept as four independently-settable fields that could drift out of sync with each
 *  other (e.g. liveEligible=true but validated=false would be a real, dangerous inconsistency a
 *  derived-from-one-source-of-truth model makes structurally impossible). */
export function deriveEvidenceFlags(state: EvidenceState): EvidenceDerivedFlags {
  const idx = EVIDENCE_LADDER.indexOf(state);
  return {
    experimental: idx <= EVIDENCE_LADDER.indexOf('EXPERIMENTAL'),
    validated: idx >= EVIDENCE_LADDER.indexOf('BACKTESTED'),
    promotable: idx >= EVIDENCE_LADDER.indexOf('ROBUST'),
    liveEligible: state === 'LIVE_ELIGIBLE',
  };
}

export interface PromotionResult {
  ok: boolean;
  newState: EvidenceState;
  error?: string;
}

/**
 * The one real gate for advancing a strategy's evidence state. Fail-closed:
 *   - Only exactly ONE rung forward is ever allowed per call (no skipping BACKTESTED -> ROBUST).
 *   - A demotion (moving backward) is always allowed - real evidence can get worse (e.g. a
 *     robustness re-run fails), and locking a strategy at its best-ever state would be dishonest.
 *   - `reason` is required and non-empty - a promotion with no stated justification is rejected,
 *     so the resulting schema.strategyEnginePromotions row this caller is expected to write always
 *     has a real, human-readable "why."
 */
export function promoteEvidence(current: EvidenceState, target: EvidenceState, reason: string): PromotionResult {
  if (!reason || reason.trim().length === 0) {
    return { ok: false, newState: current, error: 'A promotion requires a non-empty reason.' };
  }
  const currentIdx = EVIDENCE_LADDER.indexOf(current);
  const targetIdx = EVIDENCE_LADDER.indexOf(target);
  if (currentIdx === -1 || targetIdx === -1) {
    return { ok: false, newState: current, error: `Unknown evidence state: ${currentIdx === -1 ? current : target}` };
  }
  if (targetIdx < currentIdx) {
    return { ok: true, newState: target }; // demotion always allowed
  }
  if (targetIdx === currentIdx) {
    return { ok: false, newState: current, error: 'Target state is the same as the current state.' };
  }
  if (targetIdx !== currentIdx + 1) {
    return {
      ok: false,
      newState: current,
      error: `Cannot promote from ${current} directly to ${target} - the ladder must be walked one real step at a time (next valid step is ${EVIDENCE_LADDER[currentIdx + 1]}).`,
    };
  }
  return { ok: true, newState: target };
}
