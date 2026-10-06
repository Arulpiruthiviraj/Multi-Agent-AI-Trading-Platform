/**
 * Fast Lane -> Canonical Decision Spine Adapter (shadow/research only, NO live emission).
 *
 * 2026-10-06. Mission: allow valid Fast Lane evidence to be expressed in the SAME shape the
 * canonical decision pipeline already understands, while execution stays fully disabled. This
 * module does NOT call `eventBus.emitTradeIdea()` anywhere - that live wiring is deliberately left
 * for a later, separately-authorized phase, once this adapter's correctness (dedup, independence-
 * safety, provenance) has been proven in isolation. See the companion design doc
 * (`docs/design/ARGUS_FAST_CANONICAL_INTEGRATION.md`) for the full reasoning behind stopping here
 * tonight, including why a live ChiefTraderAgent instance cannot be safely used for a "shadow"
 * test in this process (it subscribes to the real, shared EventBus in its own constructor - a
 * second instance would be a second real ChiefTrader, not an isolated shadow).
 *
 * Conversion is a pure function: FastEvaluationResult + its originating FastOpportunityCandidate
 * in, a canonical-idea-SHAPED object (or an explicit rejection reason) out. The ORIGINAL strategy
 * identity is always preserved (e.g. `strategy: 'MOMENTUM_BREAKOUT'`, never `'FAST_LANE_BUY'`) -
 * Fast Lane is a transport/latency difference, never a new alpha source. `agent: 'FastOpportunityLane'`
 * is what the real `resolveIndependentEvidenceGroup()` (evidenceIndependence.ts) already groups
 * with QuantEngine/JavaCoreEnsemble, so this evidence can never inflate independence merely by
 * arriving through a second pipeline - see that file's own 2026-10-06 addition.
 */
import type { FastEvaluationResult, FastOpportunityCandidate } from './FastOpportunityCandidate';

/** The canonical-idea-shaped object this adapter produces. Matches the real shape every other
 *  emitTradeIdea() caller in this codebase builds (see JavaCoreEnsembleVoteService.ts for the
 *  precedent) - deliberately NOT a new schema. */
export interface CanonicalIdeaFromFastLane {
  traceId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  confidence: number;
  reasoning: string;
  agent: 'FastOpportunityLane';
  /** The ORIGINAL strategy identity, preserved verbatim - never overwritten with a Fast-Lane-
   *  specific label. Fast Lane is not an alpha strategy. */
  strategy: string;
  timeframe: string;
  currentPrice?: number;
  evidence: {
    origin: 'FAST_OPPORTUNITY_LANE';
    candidateId: string;
    fastEvaluationId: string;
    detectionSource: FastOpportunityCandidate['detectionSource'];
    catalyst: string | null;
    detectedAt: number;
    dataAsOf: number | null;
    evaluatedAt: number;
    marketDataType: FastEvaluationResult['marketDataType'];
    /** The candidate's own expiry - the horizon this evidence remains valid for. */
    validUntil: number;
    /** Stable fingerprint identifying the underlying evidence (see computeEvidenceFingerprint) -
     *  carried through so a downstream consumer can detect duplication without recomputing it. */
    evidenceFingerprint: string;
  };
}

export type FastCanonicalConversionRejectReason =
  | 'STATUS_NOT_VALID_EVIDENCE'
  | 'NO_TRIGGER'
  | 'CANDIDATE_EXPIRED'
  | 'MISSING_DIRECTION_OR_CONFIDENCE'
  | 'NON_FINITE_CONFIDENCE'
  | 'MISSING_STRATEGY_IDENTITY';

export type FastCanonicalConversionResult =
  | { ok: true; idea: CanonicalIdeaFromFastLane }
  | { ok: false; reason: FastCanonicalConversionRejectReason };

/**
 * 2026-10-06 (Section 17 - evidence fingerprint): identifies the SAME underlying evidence arriving
 * through multiple pathways (Normal QuantEngine cycle vs. Fast Lane). Deliberately built only from
 * STABLE identifiers - strategy, symbol, direction, and the real evaluation's own dataAsOf bucket
 * (rounded to the nearest minute, since two evaluations of the same underlying bar close should
 * fingerprint identically even if the wall-clock evaluatedAt differs by milliseconds). Never
 * hashes a volatile identifier (candidateId, evaluatedAt, traceId) that would make identical
 * evidence appear spuriously unique - the mandate's own explicit instruction.
 */
export function computeEvidenceFingerprint(input: {
  strategy: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  dataAsOf: number | null;
}): string {
  const dataAsOfBucket = input.dataAsOf != null ? Math.floor(input.dataAsOf / 60_000) : 'unknown';
  return `${input.strategy}:${input.symbol}:${input.side}:${dataAsOfBucket}`;
}

/**
 * Converts one FastEvaluationResult into a canonical-idea-shaped object, or an explicit rejection.
 * Pure function - never calls emitTradeIdea, never touches ChiefTrader/RiskEngine/OMS/BrokerManager.
 *
 * Gates (Section 2): status must be VALID_STRATEGY_EVIDENCE, a real trigger must exist
 * (bestStrategy/direction/confidence all present - fastLaneEvaluator.ts only sets these together),
 * the candidate must not be expired, and confidence must be finite. NO_VALID_SETUP,
 * INSUFFICIENT_DATA, ERROR, and EXPIRED statuses are rejected outright - never converted.
 */
export function convertFastEvaluationToCanonicalIdea(
  result: FastEvaluationResult,
  candidate: FastOpportunityCandidate,
): FastCanonicalConversionResult {
  if (result.status !== 'VALID_STRATEGY_EVIDENCE') {
    return { ok: false, reason: 'STATUS_NOT_VALID_EVIDENCE' };
  }
  if (Date.now() > candidate.expiresAt) {
    return { ok: false, reason: 'CANDIDATE_EXPIRED' };
  }
  if (!result.bestStrategy) {
    return { ok: false, reason: 'MISSING_STRATEGY_IDENTITY' };
  }
  if (!result.direction || result.confidence == null) {
    return { ok: false, reason: 'MISSING_DIRECTION_OR_CONFIDENCE' };
  }
  if (!Number.isFinite(result.confidence)) {
    return { ok: false, reason: 'NON_FINITE_CONFIDENCE' };
  }
  if (result.validTriggers.length === 0) {
    return { ok: false, reason: 'NO_TRIGGER' };
  }

  const evidenceFingerprint = computeEvidenceFingerprint({
    strategy: result.bestStrategy,
    symbol: result.symbol,
    side: result.direction,
    dataAsOf: result.dataAsOf,
  });

  return {
    ok: true,
    idea: {
      traceId: `fastlane_${result.id}`,
      symbol: result.symbol,
      side: result.direction,
      confidence: result.confidence, // no Fast Lane bonus - the raw strategy confidence, unchanged
      reasoning: `[FastOpportunityLane, detected via ${candidate.detectionSource}${candidate.catalyst ? `: ${candidate.catalyst}` : ''}] strategy=${result.bestStrategy}`,
      agent: 'FastOpportunityLane',
      strategy: result.bestStrategy, // original strategy identity, never overwritten
      timeframe: 'intraday',
      evidence: {
        origin: 'FAST_OPPORTUNITY_LANE',
        candidateId: candidate.id,
        fastEvaluationId: result.id,
        detectionSource: candidate.detectionSource,
        catalyst: candidate.catalyst ?? null,
        detectedAt: candidate.detectedAt,
        dataAsOf: result.dataAsOf,
        evaluatedAt: result.evaluatedAt,
        marketDataType: result.marketDataType,
        validUntil: candidate.expiresAt,
        evidenceFingerprint,
      },
    },
  };
}
