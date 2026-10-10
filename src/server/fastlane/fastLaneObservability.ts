/**
 * Fast Opportunity Lane — observability events.
 *
 * 2026-10-05: Every fast candidate must be traceable end-to-end. All events
 * are fired via observeSafe (fail-open logging, never affects candidate logic).
 */

import { observeSafe, structuredLogger } from '../observability/StructuredLogger';
import type { FastOpportunityCandidate, FastDetectionSource, FastOpportunityState } from './FastOpportunityCandidate';

function baseFields(c: Pick<FastOpportunityCandidate, 'id' | 'symbol' | 'detectionSource' | 'detectedAt'>) {
  return {
    category: 'FAST_LANE',
    candidateId: c.id,
    symbol: c.symbol,
    detectionSource: c.detectionSource,
    detectedAt: c.detectedAt,
  };
}

export function logFastOpportunityDetected(c: FastOpportunityCandidate): void {
  observeSafe(() => {
    structuredLogger.info('fast_opportunity_detected', {
      ...baseFields(c),
      eventType: 'FAST_OPPORTUNITY_DETECTED',
      catalyst: c.catalyst ?? null,
      priceAnomaly: c.priceAnomaly ?? null,
      volumeAnomaly: c.volumeAnomaly ?? null,
      relativeStrength: c.relativeStrength ?? null,
      expiresAt: c.expiresAt,
      requiredDataTier: c.requiredDataTier,
      applicableStrategies: c.applicableStrategies,
    });
  });
}

export function logFastDataRequested(candidateId: string, symbol: string, tier: string): void {
  observeSafe(() => {
    structuredLogger.info('fast_data_requested', {
      category: 'FAST_LANE',
      eventType: 'FAST_DATA_REQUESTED',
      candidateId, symbol, requestedTier: tier,
    });
  });
}

export function logFastDataReady(candidateId: string, symbol: string, tier: string, latencyMs: number): void {
  observeSafe(() => {
    structuredLogger.info('fast_data_ready', {
      category: 'FAST_LANE',
      eventType: 'FAST_DATA_READY',
      candidateId, symbol, tier, dataLatencyMs: latencyMs,
    });
  });
}

export function logFastStrategyEvaluated(
  candidateId: string, symbol: string,
  verdict: string, latencyMs: number, reasoning: string,
): void {
  observeSafe(() => {
    structuredLogger.info('fast_strategy_evaluated', {
      category: 'FAST_LANE',
      eventType: 'FAST_STRATEGY_EVALUATED',
      candidateId, symbol, verdict,
      evaluationLatencyMs: latencyMs, reasoning,
    });
  });
}

export function logFastNoSetup(candidateId: string, symbol: string, reason: string): void {
  observeSafe(() => {
    structuredLogger.info('fast_no_setup', {
      category: 'FAST_LANE',
      eventType: 'FAST_NO_SETUP',
      candidateId, symbol, reason,
    });
  });
}

export function logFastActionable(candidateId: string, symbol: string, strategies: string[]): void {
  observeSafe(() => {
    structuredLogger.info('fast_actionable', {
      category: 'FAST_LANE',
      eventType: 'FAST_ACTIONABLE',
      candidateId, symbol, applicableStrategies: strategies,
    });
  });
}

export function logFastExpired(candidateId: string, symbol: string, state: FastOpportunityState): void {
  observeSafe(() => {
    structuredLogger.info('fast_expired', {
      category: 'FAST_LANE',
      eventType: 'FAST_EXPIRED',
      candidateId, symbol, finalState: state,
    });
  });
}

// 2026-10-06 (Fast Opportunity Lane Evaluator): the specific per-candidate evaluation lifecycle
// events requested by the evaluator research spec - distinct from the pre-existing, more generic
// fast_strategy_evaluated/fast_no_setup/fast_actionable events above (which predate any real
// evaluator and were never wired to one). Every event carries candidateId for end-to-end tracing.
export function logFastEvaluationStarted(candidateId: string, symbol: string): void {
  observeSafe(() => {
    structuredLogger.info('fast_evaluation_started', {
      category: 'FAST_LANE', eventType: 'FAST_EVALUATION_STARTED', candidateId, symbol,
    });
  });
}

export function logFastEvaluationDataReady(candidateId: string, symbol: string, dataAsOf: number | null): void {
  observeSafe(() => {
    structuredLogger.info('fast_evaluation_data_ready', {
      category: 'FAST_LANE', eventType: 'FAST_EVALUATION_DATA_READY', candidateId, symbol, dataAsOf,
    });
  });
}

export function logFastEvaluationInsufficientData(candidateId: string, symbol: string, reasonCodes: string[]): void {
  observeSafe(() => {
    structuredLogger.info('fast_evaluation_insufficient_data', {
      category: 'FAST_LANE', eventType: 'FAST_EVALUATION_INSUFFICIENT_DATA', candidateId, symbol, reasonCodes,
    });
  });
}

export function logFastEvaluationNoSetup(candidateId: string, symbol: string, strategiesEvaluated: string[]): void {
  observeSafe(() => {
    structuredLogger.info('fast_evaluation_no_setup', {
      category: 'FAST_LANE', eventType: 'FAST_EVALUATION_NO_SETUP', candidateId, symbol, strategiesEvaluated,
    });
  });
}

export function logFastEvaluationValidEvidence(candidateId: string, symbol: string, bestStrategy: string, confidence: number): void {
  observeSafe(() => {
    structuredLogger.info('fast_evaluation_valid_evidence', {
      category: 'FAST_LANE', eventType: 'FAST_EVALUATION_VALID_EVIDENCE', candidateId, symbol, bestStrategy, confidence,
    });
  });
}

export function logFastEvaluationExpired(candidateId: string, symbol: string): void {
  observeSafe(() => {
    structuredLogger.info('fast_evaluation_expired', {
      category: 'FAST_LANE', eventType: 'FAST_EVALUATION_EXPIRED', candidateId, symbol,
    });
  });
}

export function logFastEvaluationFailed(candidateId: string, symbol: string, errorType: string): void {
  observeSafe(() => {
    structuredLogger.info('fast_evaluation_failed', {
      category: 'FAST_LANE', eventType: 'FAST_EVALUATION_FAILED', candidateId, symbol, errorType,
    });
  });
}

// 2026-10-06 (Fast Lane Canonical Integration, Section 13). All include candidateId/evaluationId/
// canonicalIdeaId where applicable for end-to-end forensic tracing. None of these calls gate or
// alter any real decision - purely observational, same fail-open observeSafe pattern as every
// other event in this file. FAST_CANONICAL_CONSENSUS_ENTERED is defined for a later, separately-
// authorized phase that actually wires live emission - not called anywhere in this phase.
export function logFastCanonicalIdeaCreated(candidateId: string, evaluationId: string, canonicalIdeaId: string, symbol: string, strategy: string): void {
  observeSafe(() => {
    structuredLogger.info('fast_canonical_idea_created', {
      category: 'FAST_LANE', eventType: 'FAST_CANONICAL_IDEA_CREATED',
      candidateId, evaluationId, canonicalIdeaId, symbol, strategy,
    });
  });
}

export function logFastCanonicalIdeaDeduped(candidateId: string, evaluationId: string, canonicalIdeaId: string, symbol: string): void {
  observeSafe(() => {
    structuredLogger.info('fast_canonical_idea_deduped', {
      category: 'FAST_LANE', eventType: 'FAST_CANONICAL_IDEA_DEDUPED',
      candidateId, evaluationId, canonicalIdeaId, symbol,
    });
  });
}

export function logFastCanonicalIdeaReplacedStale(candidateId: string, symbol: string, previousEvaluationId: string, newEvaluationId: string): void {
  observeSafe(() => {
    structuredLogger.info('fast_canonical_idea_replaced_stale', {
      category: 'FAST_LANE', eventType: 'FAST_CANONICAL_IDEA_REPLACED_STALE',
      candidateId, symbol, previousEvaluationId, newEvaluationId,
    });
  });
}

export function logFastCanonicalIdeaRejected(candidateId: string, symbol: string, reason: string): void {
  observeSafe(() => {
    structuredLogger.info('fast_canonical_idea_rejected', {
      category: 'FAST_LANE', eventType: 'FAST_CANONICAL_IDEA_REJECTED',
      candidateId, symbol, reason,
    });
  });
}

export function logFastCanonicalConsensusEntered(candidateId: string, canonicalIdeaId: string, symbol: string): void {
  observeSafe(() => {
    structuredLogger.info('fast_canonical_consensus_entered', {
      category: 'FAST_LANE', eventType: 'FAST_CANONICAL_CONSENSUS_ENTERED',
      candidateId, canonicalIdeaId, symbol,
    });
  });
}

export function logFastResourcePromotionRequested(
  candidateId: string, symbol: string,
  requestedTier: string, reason: string,
): void {
  observeSafe(() => {
    structuredLogger.info('fast_resource_promotion_requested', {
      category: 'FAST_LANE',
      eventType: 'FAST_RESOURCE_PROMOTION_REQUESTED',
      candidateId, symbol, requestedTier, reason,
    });
  });
}

// 2026-10-09 (P1 fast-lane lease fix): lease lifecycle observability.
//
// A lease = the concurrency slot + the per-symbol dedup entry, acquired together when an
// evaluation starts and held until the underlying work SETTLES (resolves or rejects) - never
// released on caller timeout. Work states:
//   RUNNING            - underlying evaluateSymbol() still executing, a caller is still waiting
//   CALLER_TIMED_OUT   - the caller's watchdog fired; the caller got its timeout result but the
//                        lease is still held (slot + dedup) until the late work settles
//   QUARANTINED        - bounded hung-work recovery: the slot was returned to the capacity pool
//                        while the dedup entry is kept (no replacement concurrent work allowed);
//                        explicit degraded state, never silent
// (SETTLED leases are removed from the book immediately; they appear only in the settle event.)
export type FastLaneLeaseWorkState = 'RUNNING' | 'CALLER_TIMED_OUT' | 'QUARANTINED';

export interface FastLaneLeaseSnapshot {
  candidateId: string;
  symbol: string;
  generation: number;
  acquiredAt: number;
  ageMs: number;
  state: FastLaneLeaseWorkState;
  /** Whether this lease currently holds one of the bounded concurrency slots. */
  slotHeld: boolean;
  /** Whether any caller has observed a timeout on this lease. */
  timedOut: boolean;
}

export interface FastLaneLeaseBookSnapshot {
  generatedAt: number;
  generation: number;
  /** Leases currently on the book (RUNNING / CALLER_TIMED_OUT / QUARANTINED). */
  activeLeaseCount: number;
  /** Concurrency slots currently held by leases (<= fastLaneMaxConcurrentEvaluations). */
  slotsHeld: number;
  /** Age of the oldest lease on the book, ms. 0 when the book is empty. */
  oldestLeaseAgeMs: number;
  /** Oldest-first, so the longest-held lease is leases[0]. */
  leases: FastLaneLeaseSnapshot[];
}

export function logFastLeaseAcquired(candidateId: string, symbol: string, generation: number): void {
  observeSafe(() => {
    structuredLogger.info('fast_lease_acquired', {
      category: 'FAST_LANE', eventType: 'FAST_LEASE_ACQUIRED', candidateId, symbol, generation,
    });
  });
}

export function logFastLeaseCallerTimeout(
  candidateId: string, symbol: string, generation: number, leaseAgeMs: number, consecutiveTimeouts: number,
): void {
  observeSafe(() => {
    structuredLogger.info('fast_lease_caller_timeout', {
      category: 'FAST_LANE', eventType: 'FAST_LEASE_CALLER_TIMEOUT',
      candidateId, symbol, generation, leaseAgeMs, consecutiveTimeouts,
    });
  });
}

export function logFastLeaseSettled(
  candidateId: string, symbol: string, generation: number, leaseAgeMs: number,
  resultStatus: string, lateSettle: boolean,
): void {
  observeSafe(() => {
    structuredLogger.info('fast_lease_settled', {
      category: 'FAST_LANE', eventType: 'FAST_LEASE_SETTLED',
      candidateId, symbol, generation, leaseAgeMs, resultStatus, lateSettle,
    });
  });
}

export function logFastLeaseQuarantined(
  candidateId: string, symbol: string, generation: number, reason: string,
  leaseAgeMs: number, consecutiveTimeouts: number,
): void {
  observeSafe(() => {
    structuredLogger.info('fast_lease_quarantined', {
      category: 'FAST_LANE', eventType: 'FAST_LEASE_QUARANTINED',
      candidateId, symbol, generation, reason, leaseAgeMs, consecutiveTimeouts,
    });
  });
}

export function logFastLeaseLateSettleDiscarded(candidateId: string, symbol: string, generation: number): void {
  observeSafe(() => {
    structuredLogger.info('fast_lease_late_settle_discarded', {
      category: 'FAST_LANE', eventType: 'FAST_LEASE_LATE_SETTLE_DISCARDED',
      candidateId, symbol, generation,
    });
  });
}

/** Structured snapshot of the whole lease book (see getFastLaneLeaseSnapshot in fastLaneEvaluator.ts). */
export function logFastLeaseBookSnapshot(snapshot: FastLaneLeaseBookSnapshot): void {
  observeSafe(() => {
    structuredLogger.info('fast_lease_book_snapshot', {
      category: 'FAST_LANE',
      eventType: 'FAST_LEASE_BOOK_SNAPSHOT',
      generatedAt: snapshot.generatedAt,
      generation: snapshot.generation,
      activeLeaseCount: snapshot.activeLeaseCount,
      slotsHeld: snapshot.slotsHeld,
      oldestLeaseAgeMs: snapshot.oldestLeaseAgeMs,
      leases: snapshot.leases.map((l) => ({
        candidateId: l.candidateId,
        symbol: l.symbol,
        generation: l.generation,
        ageMs: l.ageMs,
        state: l.state,
        slotHeld: l.slotHeld,
        timedOut: l.timedOut,
      })),
    });
  });
}
