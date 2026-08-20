/**
 * Additive prediction-vs-outcome evidence for Historical Evaluation (MODE B).
 *
 * Captures machine-analyzable decision snapshots (agent votes, consensus math, optional risk
 * gates) during the replay loop, then attaches forward returns / MFE / MAE ONLY after the run
 * reaches a terminal status — never inside processTimestamp() (same AFTER-THE-FACT contract as
 * MissedOpportunityAnalysis). Does not auto-tune live weights or thresholds.
 *
 * Schema: argus.historical_decision_evidence.v1
 */
import type { ResearchBar } from '../research/ohlcvTypes';
import { replaySafety } from './replaySafety';
import { tradingSafety } from '../config/tradingSafety';

export const DECISION_EVIDENCE_SCHEMA = 'argus.historical_decision_evidence.v1' as const;

export type DecisionStageOutcome =
  | 'CONSENSUS_REJECTED'
  | 'RISK_REJECTED'
  | 'ORDER_FILLED'
  | 'ORDER_REJECTED_OTHER';

export interface DecisionAgentVote {
  agent: string;
  side: string;
  confidence: number;
  weight: number | null;
}

export interface DecisionRiskGateSnapshot {
  gateName: string;
  sequence: number;
  passed: boolean;
}

export interface DecisionEvidenceRecord {
  schema: typeof DECISION_EVIDENCE_SCHEMA;
  symbol: string;
  timestamp: number;
  strategyId: string;
  predictedSide: 'BUY' | 'SELL' | 'HOLD';
  referencePrice: number;
  agentVotes: DecisionAgentVote[];
  independentAgreeingAgents: number;
  weightedConfidence: number;
  consensusThreshold: number;
  minIndependentAgreeingAgents: number;
  consensusApproved: boolean;
  consensusReason: string;
  stageOutcome: DecisionStageOutcome;
  rejectionGate: string | null;
  riskGates: DecisionRiskGateSnapshot[] | null;
  traceId: string | null;
  /** Populated post-run only from bars never visible at decision time. */
  forwardReturnPct: number | null;
  mfePct: number | null;
  maePct: number | null;
  horizonBars: number;
  barsAvailableAfterDecision: number;
  label: 'AFTER-THE-FACT ANALYSIS' | 'DECISION_TIME_ONLY';
}

export interface DecisionEvidenceInput {
  symbol: string;
  timestamp: number;
  strategyId: string;
  predictedSide: 'BUY' | 'SELL' | 'HOLD';
  referencePrice: number;
  agentVotes: DecisionAgentVote[];
  independentAgreeingAgents: number;
  weightedConfidence: number;
  consensusApproved: boolean;
  consensusReason: string;
  stageOutcome: DecisionStageOutcome;
  rejectionGate?: string | null;
  riskGates?: DecisionRiskGateSnapshot[] | null;
  traceId?: string | null;
}

export function buildDecisionEvidenceRecord(input: DecisionEvidenceInput): DecisionEvidenceRecord {
  return {
    schema: DECISION_EVIDENCE_SCHEMA,
    symbol: input.symbol,
    timestamp: input.timestamp,
    strategyId: input.strategyId,
    predictedSide: input.predictedSide,
    referencePrice: input.referencePrice,
    agentVotes: input.agentVotes,
    independentAgreeingAgents: input.independentAgreeingAgents,
    weightedConfidence: input.weightedConfidence,
    consensusThreshold: tradingSafety.consensusApprovalThreshold,
    minIndependentAgreeingAgents: tradingSafety.minIndependentAgreeingAgents,
    consensusApproved: input.consensusApproved,
    consensusReason: input.consensusReason,
    stageOutcome: input.stageOutcome,
    rejectionGate: input.rejectionGate ?? null,
    riskGates: input.riskGates ?? null,
    traceId: input.traceId ?? null,
    forwardReturnPct: null,
    mfePct: null,
    maePct: null,
    horizonBars: replaySafety.missedOpportunityHorizonBars,
    barsAvailableAfterDecision: 0,
    label: 'DECISION_TIME_ONLY',
  };
}

/**
 * Attach forward returns / MFE / MAE from the full bar series (post-run only).
 * Does not mutate stageOutcome or decision-time fields.
 */
export function enrichDecisionEvidenceWithOutcomes(
  records: DecisionEvidenceRecord[],
  barsBySymbol: Map<string, ResearchBar[]>,
  opts?: { horizonBars?: number },
): DecisionEvidenceRecord[] {
  const horizonBars = opts?.horizonBars ?? replaySafety.missedOpportunityHorizonBars;
  return records.map((rec) => {
    const allBars = barsBySymbol.get(rec.symbol.toUpperCase()) || [];
    const after = allBars.filter((b) => b.timestamp > rec.timestamp).slice(0, horizonBars);
    if (after.length === 0 || rec.referencePrice <= 0) {
      return {
        ...rec,
        horizonBars,
        barsAvailableAfterDecision: after.length,
        forwardReturnPct: null,
        mfePct: null,
        maePct: null,
        label: 'AFTER-THE-FACT ANALYSIS',
      };
    }
    const highs = after.map((b) => b.high);
    const lows = after.map((b) => b.low);
    const mfePct = ((Math.max(...highs) - rec.referencePrice) / rec.referencePrice) * 100;
    const maePct = ((Math.min(...lows) - rec.referencePrice) / rec.referencePrice) * 100;
    const forwardReturnPct = ((after[after.length - 1].close - rec.referencePrice) / rec.referencePrice) * 100;
    // For SELL predictions, favorable = price down (invert excursion signs for directional MFE/MAE).
    const directionalMfe = rec.predictedSide === 'SELL' ? -maePct : mfePct;
    const directionalMae = rec.predictedSide === 'SELL' ? -mfePct : maePct;
    return {
      ...rec,
      horizonBars,
      barsAvailableAfterDecision: after.length,
      forwardReturnPct: Number(forwardReturnPct.toFixed(4)),
      mfePct: Number(directionalMfe.toFixed(4)),
      maePct: Number(directionalMae.toFixed(4)),
      label: 'AFTER-THE-FACT ANALYSIS',
    };
  });
}

export function summarizeDecisionEvidence(records: DecisionEvidenceRecord[]): {
  schema: typeof DECISION_EVIDENCE_SCHEMA;
  count: number;
  byStageOutcome: Record<string, number>;
  withForwardOutcome: number;
  note: string;
} {
  const byStageOutcome: Record<string, number> = {};
  let withForwardOutcome = 0;
  for (const r of records) {
    byStageOutcome[r.stageOutcome] = (byStageOutcome[r.stageOutcome] || 0) + 1;
    if (r.forwardReturnPct != null) withForwardOutcome += 1;
  }
  return {
    schema: DECISION_EVIDENCE_SCHEMA,
    count: records.length,
    byStageOutcome,
    withForwardOutcome,
    note: 'Additive machine-analysis export for Historical Evaluation. Does not auto-tune live agent weights, consensus floors, or RiskEngine gates. Forward MFE/MAE are AFTER-THE-FACT only.',
  };
}

/** Honesty block for summary / report — aiMode does not invent LLM votes. */
export function buildAiModeHonesty(aiMode: string): {
  configuredAiMode: string;
  llmVotesInvoked: false;
  reason: string;
  consensusImplication: string;
} {
  const base = replaySafety.aiModeHonestyDescription;
  return {
    configuredAiMode: aiMode,
    llmVotesInvoked: false,
    reason: base,
    consensusImplication:
      aiMode === 'DISABLED' || aiMode === 'AI_DISABLED'
        ? 'AI_DISABLED / DISABLED: approval requires ≥2 independent non-LLM voters (typically QuantEngine + TechnicalAgent when Technical independently fires) at consensusApprovalThreshold; Quant alone cannot approve.'
        : 'LIVE_MODEL_REPLAY / RECORDED_DECISION_REPLAY are labeled but not wired to AIRouter/routeConsensus (no PIT LLM corpus). Consensus math is identical to DISABLED until a real recorded-decision ledger exists.',
  };
}
