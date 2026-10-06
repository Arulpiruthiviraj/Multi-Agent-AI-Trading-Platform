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
