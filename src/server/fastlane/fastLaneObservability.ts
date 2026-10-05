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
