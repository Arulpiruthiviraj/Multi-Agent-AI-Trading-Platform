/**
 * Phase 4B Part 2 (Shadow validation, 2026-08-26): persists legacy-vs-shadow consensus divergence.
 * Read-only from the caller's perspective - never throws, never blocks, never influences the real
 * decision. Reuses observability_events (no new table/migration) exactly like this session's
 * earlier QUANT_CORE_PARITY_DIVERGENCE and CONFLUENCE_COORDINATOR_TRIGGERED dashboards.
 *
 * 2026-09-11 addition: a THIRD, separate shadow variant (`rawSignalShadow`) - same
 * computeShadowConsensus() aggregation (same HOLD-does-not-dilute, same excluded-vote handling
 * already validated by `shadow`), but built from each agent's RAW, pre-calibration confidence
 * (the "current signal strength" the agent itself reported this cycle) instead of the
 * calibration-substituted value. Real, same-day finding this tests: a live audit of today's 696
 * real consensus rounds found `shadow` (HOLD-dilution fix alone) agreed with the legacy live
 * decision on every single round (0 disagreements, max shadow confidence 63.5%) - meaning
 * HOLD-dilution was NOT the active bottleneck today. The calibration-as-ceiling hypothesis
 * (agents' confidence is substituted with their own historical accuracy, ~45-63% for most agents,
 * which mathematically caps weighted consensus well below 0.75 regardless of agreement structure)
 * was the next real, testable hypothesis - `rawSignalShadow` measures it directly, still fully
 * shadow-only, zero live impact.
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
  /** Optional so any existing consumer of this event that only reads the legacy/shadow fields is
   *  unaffected if this is ever omitted - always provided by ChiefTraderAgent.ts's own caller. */
  rawSignalShadow?: ShadowConsensusResult;
}

export function recordConsensusModelComparison(input: ConsensusComparisonInput): void {
  const shadowApproved = input.shadow.finalDecision !== 'HOLD' && input.shadow.aggregateConfidence > input.threshold;
  const agree = input.legacyApproved === shadowApproved && (!input.legacyApproved || input.legacyDecision === input.shadow.finalDecision);

  const rawSignalApproved = input.rawSignalShadow
    ? input.rawSignalShadow.finalDecision !== 'HOLD' && input.rawSignalShadow.aggregateConfidence > input.threshold
    : undefined;
  const agreeWithRawSignal = input.rawSignalShadow
    ? input.legacyApproved === rawSignalApproved && (!input.legacyApproved || input.legacyDecision === input.rawSignalShadow.finalDecision)
    : undefined;

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
      rawSignalDecision: input.rawSignalShadow?.finalDecision ?? null,
      rawSignalApproved: rawSignalApproved ?? null,
      rawSignalConfidence: input.rawSignalShadow?.aggregateConfidence ?? null,
      rawSignalBullish: input.rawSignalShadow?.bullishEvidence ?? null,
      rawSignalBearish: input.rawSignalShadow?.bearishEvidence ?? null,
      rawSignalReasonCode: input.rawSignalShadow?.reasonCode ?? null,
      agreeWithRawSignal: agreeWithRawSignal ?? null,
    });
  });
}
