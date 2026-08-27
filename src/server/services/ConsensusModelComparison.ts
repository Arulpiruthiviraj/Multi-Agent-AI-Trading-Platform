/**
 * Phase 4B Part 2 (Shadow validation, 2026-08-26): persists legacy-vs-shadow consensus divergence.
 * Read-only from the caller's perspective - never throws, never blocks, never influences the real
 * decision. Reuses observability_events (no new table/migration) exactly like this session's
 * earlier QUANT_CORE_PARITY_DIVERGENCE and CONFLUENCE_COORDINATOR_TRIGGERED dashboards.
 */
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';
import type { ShadowConsensusResult } from './EvidenceAwareVote';

export interface ConsensusComparisonInput {
  traceId: string;
  symbol: string;
  legacyDecision: 'BUY' | 'SELL' | 'HOLD';
  legacyApproved: boolean;
  legacyConfidence: number;
  threshold: number;
  shadow: ShadowConsensusResult;
}

export function recordConsensusModelComparison(input: ConsensusComparisonInput): void {
  const shadowApproved = input.shadow.finalDecision !== 'HOLD' && input.shadow.aggregateConfidence > input.threshold;
  const agree = input.legacyApproved === shadowApproved && (!input.legacyApproved || input.legacyDecision === input.shadow.finalDecision);

  observeSafe(() => {
    structuredLogger.info('consensus_model_comparison', {
      category: 'CONSENSUS',
      eventType: 'CONSENSUS_MODEL_COMPARISON',
      symbol: input.symbol,
      traceId: input.traceId,
      decisionId: input.traceId,
      legacyDecision: input.legacyDecision,
      legacyApproved: input.legacyApproved,
      legacyConfidence: input.legacyConfidence,
      shadowDecision: input.shadow.finalDecision,
      shadowApproved,
      shadowConfidence: input.shadow.aggregateConfidence,
      bullishEvidence: input.shadow.bullishEvidence,
      bearishEvidence: input.shadow.bearishEvidence,
      uncertainty: input.shadow.uncertainty,
      excludedAgents: input.shadow.excludedAgents,
      reasonCode: input.shadow.reasonCode,
      threshold: input.threshold,
      agree,
    });
  });
}
