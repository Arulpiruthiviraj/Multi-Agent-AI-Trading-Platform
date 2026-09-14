/**
 * ==========================================================
 * Module: ConsensusDebateForensics
 *
 * ConsensusDebate P0.5 forensic measurement (2026-09-13). See consensus_debate_predictions'
 * own schema doc comment (src/server/db/schema.ts) for the full rationale: ChiefTraderAgent.ts's
 * adversarial AI debate can HARD-VETO an otherwise-approvable round regardless of weighted
 * confidence, and its own predictive value has never been measured anywhere in this codebase.
 *
 * This module is pure capture: it computes the real counterfactual (EvidenceAggregator.aggregate()
 * called a second time, excluding ConsensusDebate's own evidence row - the exact real code path,
 * not a reimplemented approximation) and persists one row per debate involvement, valid or
 * fail-closed. It never changes what ChiefTraderAgent actually decides - OBSERVATION ONLY, per the
 * mandate's own explicit instruction. Outcome grading happens later, in
 * ConsensusDebateOutcomeEvaluator.ts, reusing the existing prediction_outcomes table.
 * ==========================================================
 */
import { db } from '../db';
import { consensusDebatePredictions } from '../db/schema';
import { EvidenceAggregator, type Evidence, type AggregationResult } from './EvidenceAggregator';
import { tradingSafety } from '../config/tradingSafety';
import crypto from 'crypto';

const CONSENSUS_APPROVAL_THRESHOLD = tradingSafety.consensusApprovalThreshold;
const MIN_INDEPENDENT_AGREEING_AGENTS = tradingSafety.minIndependentAgreeingAgents;

export type DebateStatus = 'VALID_PREDICTION' | 'FAIL_CLOSED_NO_ROUTE' | 'FAIL_CLOSED_ERROR' | 'FAIL_CLOSED_NO_VERDICT';

export interface CaptureConsensusDebateInput {
  traceId: string;
  symbol: string;
  /** Full evidence array ChiefTrader actually aggregated (includes ConsensusDebate's row when present). */
  evidence: Evidence[];
  /** The real, already-computed aggregation result INCLUDING ConsensusDebate's evidence. */
  result: AggregationResult;
  /** The real final approval outcome for this round (post full ladder, including debateSaidHold veto). */
  withDebateApproved: boolean;
  /** Real debate provider telemetry, when a valid (non-fail-closed) debate vote was cast. */
  debateTelemetry?: { providers_attempted: number; providers_succeeded: number; providers_failed: number };
  /** Set when debate was attempted but fail-closed (no vote was cast at all). */
  failClosed?: { status: Exclude<DebateStatus, 'VALID_PREDICTION'>; providersAttempted: number; providersSucceeded: number; providersFailed: number };
  marketRegime?: string | null;
}

/**
 * Pure: computes the base (debate-excluded) counterfactual via the SAME EvidenceAggregator used
 * for the real decision, and returns a full row ready to persist. Returns null only when there is
 * nothing to capture (no ConsensusDebate evidence row AND no failClosed info) - i.e. debate was
 * never invoked for this round at all.
 */
export function computeConsensusDebateCapture(input: CaptureConsensusDebateInput): typeof consensusDebatePredictions.$inferInsert | null {
  const debateEvidence = input.evidence.find((e) => e.agent === 'ConsensusDebate');
  if (!debateEvidence && !input.failClosed) return null;

  const evidenceWithoutDebate = input.evidence.filter((e) => e.agent !== 'ConsensusDebate');
  const baseResult = EvidenceAggregator.aggregate(evidenceWithoutDebate);
  const baseIndependentAgents = new Set(baseResult.agreements.map((e) => e.agent));
  const baseClearsThreshold = baseResult.side !== 'HOLD' && baseResult.confidence > CONSENSUS_APPROVAL_THRESHOLD;
  const baseClearsIndependence = baseIndependentAgents.size >= MIN_INDEPENDENT_AGREEING_AGENTS;

  const debateStatus: DebateStatus = input.failClosed ? input.failClosed.status : 'VALID_PREDICTION';
  const debateDirection = debateEvidence?.side ?? null;
  const debateConfidence = debateEvidence?.confidence ?? null;
  const vetoFired = debateDirection === 'HOLD' && baseClearsThreshold && baseClearsIndependence && !input.withDebateApproved;

  return {
    id: crypto.randomUUID(),
    traceId: input.traceId,
    symbol: input.symbol,
    createdAt: new Date().toISOString(),
    debateStatus,
    debateDirection,
    debateConfidence,
    providersAttempted: input.failClosed?.providersAttempted ?? input.debateTelemetry?.providers_attempted ?? 0,
    providersSucceeded: input.failClosed?.providersSucceeded ?? input.debateTelemetry?.providers_succeeded ?? 0,
    providersFailed: input.failClosed?.providersFailed ?? input.debateTelemetry?.providers_failed ?? 0,
    underlyingAgentCount: evidenceWithoutDebate.length,
    underlyingEvidenceJson: JSON.stringify(evidenceWithoutDebate.map((e) => ({
      agent: e.agent, side: e.side, confidence: e.confidence, weight: e.weight,
      agreed: e.side === baseResult.side,
    }))),
    baseConsensusSide: baseResult.side,
    baseConsensusConfidence: baseResult.confidence,
    baseClearsThreshold,
    baseClearsIndependence,
    withDebateConsensusSide: input.result.side,
    withDebateConsensusConfidence: input.result.confidence,
    withDebateApproved: input.withDebateApproved,
    vetoFired,
    marketRegime: input.marketRegime ?? null,
  };
}

/** Persists the capture row. Best-effort, never throws into the caller - this is observational
 *  telemetry and must never affect the real trading decision it is recording. */
export async function persistConsensusDebateCapture(input: CaptureConsensusDebateInput): Promise<void> {
  const row = computeConsensusDebateCapture(input);
  if (!row) return;
  try {
    await db.insert(consensusDebatePredictions).values(row);
  } catch (e) {
    console.error('[ConsensusDebateForensics] Failed to persist capture row', e);
  }
}
