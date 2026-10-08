/**
 * Phase 9 (2026-08-27) - the aggregated "why no trade" dashboard. Built entirely from real,
 * persisted data: the new CONSENSUS_TERMINAL_REASON structured-log rows ChiefTraderAgent.ts now
 * emits every round (see its own header comment for why the generic EventBus->observability
 * bridge could not be reused - it only ever persisted {symbol} for DESK_NO_TRADE/
 * CHIEF_CONSENSUS_COMPLETED), plus the pre-existing risk_assessments/trades/fills tables for the
 * downstream funnel. Rows before this was deployed simply do not exist - the report is honest
 * about its own `sinceIso` window rather than fabricating historical terminal-reason data.
 */
import { db } from '../db';
import { observabilityEvents, riskAssessments, trades, fills } from '../db/schema';
import { and, eq, gte, lt } from 'drizzle-orm';
import { classifyTradeEnvironment, isReplayTraceId } from '../research/organicPaper';

export interface ConsensusPipelineReport {
  windowSinceIso: string;
  windowUntilIso: string;
  evaluations: number;
  directionalEvaluations: number;
  holdCount: number;
  approvedCount: number;
  independentAgreementCounts: { '0': number; '1': number; '2': number; '3': number; '4+': number };
  confidenceAtLeast60: number;
  confidenceAtLeast75: number;
  moderateEligibleCount: number;
  strongApprovedCount: number;
  riskEngineReached: number;
  riskApproved: number;
  ordersPlaced: number;
  fillsRecorded: number;
  topTerminalReasons: Array<{ code: string; count: number }>;
  /** Directional (BUY/SELL) vote count per agent, within the window - the per-agent participation
   *  breakdown requested during the Phase 9 zero-trade audit. */
  directionalVotesByAgent: Record<string, number>;
  /** RiskEngine-gate-level rejection breakdown (2026-09-23, operator-directed forensic follow-up):
   *  distinct from topTerminalReasons above, which is ChiefTrader's own terminal classification
   *  (e.g. CONFIDENCE_BELOW_STRONG) - this counts, per real non-replay risk_assessments row that
   *  reached RiskEngine and was rejected, WHICH of the 25 gates was the recorded first-failure
   *  (RiskEngine.ts's own reported rejectionGate). Answers "is one gate systematically overblocking,
   *  or are risk rejections genuinely diverse" - a real, previously-unanswerable question, since no
   *  prior report aggregated risk_assessments.rejectionGate at all. */
  topRiskGateRejections: Array<{ gateName: string; count: number }>;
  /** Overlapping observed conditions, not counterfactual approvals or additional gate results. */
  evidenceDiagnostics: {
    independenceKnown: number;
    independenceUnknown: number;
    belowRequiredEvidenceGroups: number;
    roundsWithCalibrationReduction: number;
    confidenceBelowStrongAndBelowRequiredGroups: number;
  };
}

export async function buildConsensusPipelineReport(sinceIso: string, untilIso = new Date().toISOString()): Promise<ConsensusPipelineReport> {
  const start = Date.parse(sinceIso), end = Date.parse(untilIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error('Consensus pipeline report requires a valid increasing time window');
  }
  // Text timestamp columns compare lexically: normalize offset-bearing input to UTC first.
  sinceIso = new Date(start).toISOString();
  untilIso = new Date(end).toISOString();
  const rows = await db.select().from(observabilityEvents).where(
    and(eq(observabilityEvents.eventType, 'CONSENSUS_TERMINAL_REASON'), gte(observabilityEvents.ts, start), lt(observabilityEvents.ts, end)),
  );

  const parsed = rows.filter(r => !isReplayTraceId(r.traceId)).map((r) => {
    try { return JSON.parse(r.payload as string); } catch { return null; }
  }).filter((p): p is Record<string, any> => p !== null && typeof p === 'object' && !Array.isArray(p));

  const independentAgreementCounts = { '0': 0, '1': 0, '2': 0, '3': 0, '4+': 0 };
  let directionalEvaluations = 0;
  let holdCount = 0;
  let approvedCount = 0;
  let confidenceAtLeast60 = 0;
  let confidenceAtLeast75 = 0;
  let moderateEligibleCount = 0;
  let strongApprovedCount = 0;
  const terminalReasonCounts = new Map<string, number>();
  const directionalVotesByAgent: Record<string, number> = {};
  const evidenceDiagnostics = {
    independenceKnown: 0, independenceUnknown: 0, belowRequiredEvidenceGroups: 0,
    roundsWithCalibrationReduction: 0, confidenceBelowStrongAndBelowRequiredGroups: 0,
  };

  for (const p of parsed) {
    const groupsKnown = Number.isInteger(p.independentEvidenceGroupCount) && p.independentEvidenceGroupCount >= 0 &&
      Number.isInteger(p.requiredIndependentEvidenceGroups) && p.requiredIndependentEvidenceGroups > 0;
    if (groupsKnown) {
      evidenceDiagnostics.independenceKnown++;
      if (p.independentEvidenceGroupCount < p.requiredIndependentEvidenceGroups) {
        evidenceDiagnostics.belowRequiredEvidenceGroups++;
        if (p.terminalReasonCode === 'CONFIDENCE_BELOW_STRONG') evidenceDiagnostics.confidenceBelowStrongAndBelowRequiredGroups++;
      }
    } else evidenceDiagnostics.independenceUnknown++;
    if (Array.isArray(p.participatingAgents) && p.participatingAgents.some((a: any) =>
      (a?.side === 'BUY' || a?.side === 'SELL') && Number.isFinite(a.rawSignalStrength) &&
      Number.isFinite(a.confidence) && Number.isFinite(a.historicalReliability) &&
      a.confidence < a.rawSignalStrength)) evidenceDiagnostics.roundsWithCalibrationReduction++;
    const n = typeof p.independentAgentCount === 'number' ? p.independentAgentCount : 0;
    const bucket = n >= 4 ? '4+' : String(n) as '0' | '1' | '2' | '3';
    independentAgreementCounts[bucket] = (independentAgreementCounts[bucket] ?? 0) + 1;

    const rawConfidence = typeof p.rawConfidence === 'number' ? p.rawConfidence : 0;
    if (rawConfidence >= 0.6) confidenceAtLeast60++;
    if (rawConfidence >= 0.75) confidenceAtLeast75++;

    if (p.approved) {
      approvedCount++;
      if (p.decisionTier === 'MODERATE') moderateEligibleCount++;
      else strongApprovedCount++;
    } else if (p.terminalReasonCode === 'AGENT_HOLD' || p.terminalReasonCode === 'AGENT_DATA_UNAVAILABLE') {
      holdCount++;
    }
    if (Array.isArray(p.participatingAgents)) {
      const hasDirectional = p.participatingAgents.some((a: any) => a?.side === 'BUY' || a?.side === 'SELL');
      if (hasDirectional) directionalEvaluations++;
      for (const a of p.participatingAgents) {
        if (a?.side === 'BUY' || a?.side === 'SELL') {
          directionalVotesByAgent[a.agent] = (directionalVotesByAgent[a.agent] ?? 0) + 1;
        }
      }
    }

    const code = typeof p.terminalReasonCode === 'string' ? p.terminalReasonCode : 'UNKNOWN';
    terminalReasonCounts.set(code, (terminalReasonCounts.get(code) ?? 0) + 1);
  }

  // Real defect found 2026-09-01: these three queries counted HISTORICAL_REPLAY-tagged rows as
  // organic activity whenever a replay run shared this production DB (risk_assessments has no
  // environment column at all, so trace_id prefix is the only signal; trades/fills are excluded
  // via the same classifyTradeEnvironment() organic paper already uses everywhere else).
  const riskRowsAll = await db.select().from(riskAssessments).where(and(gte(riskAssessments.createdAt, sinceIso), lt(riskAssessments.createdAt, untilIso)));
  const riskRows = riskRowsAll.filter((r) => !isReplayTraceId(r.traceId));
  const orderRowsAll = await db.select().from(trades).where(and(gte(trades.submittedAt, sinceIso), lt(trades.submittedAt, untilIso)));
  const orderRows = orderRowsAll.filter((r) => classifyTradeEnvironment(r) !== 'REPLAY');
  const fillRowsAll = await db.select({
    id: fills.id,
    executionEnvironment: trades.executionEnvironment,
    traceId: trades.traceId,
    reasoning: trades.reasoning,
  }).from(fills).innerJoin(trades, eq(fills.orderId, trades.id)).where(and(gte(fills.filledAt, sinceIso), lt(fills.filledAt, untilIso)));
  const fillRows = fillRowsAll.filter((r) => classifyTradeEnvironment(r) !== 'REPLAY');

  const topTerminalReasons = Array.from(terminalReasonCounts.entries())
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);

  const riskGateRejectionCounts = new Map<string, number>();
  for (const r of riskRows) {
    if (r.approved || !r.rejectionGate) continue;
    riskGateRejectionCounts.set(r.rejectionGate, (riskGateRejectionCounts.get(r.rejectionGate) ?? 0) + 1);
  }
  const topRiskGateRejections = Array.from(riskGateRejectionCounts.entries())
    .map(([gateName, count]) => ({ gateName, count }))
    .sort((a, b) => b.count - a.count);

  return {
    windowSinceIso: sinceIso,
    windowUntilIso: untilIso,
    evaluations: parsed.length,
    directionalEvaluations,
    holdCount,
    approvedCount,
    independentAgreementCounts,
    confidenceAtLeast60,
    confidenceAtLeast75,
    moderateEligibleCount,
    strongApprovedCount,
    riskEngineReached: riskRows.length,
    riskApproved: riskRows.filter((r) => r.approved).length,
    ordersPlaced: orderRows.length,
    fillsRecorded: fillRows.length,
    topTerminalReasons,
    directionalVotesByAgent,
    topRiskGateRejections,
    evidenceDiagnostics,
  };
}

export function formatConsensusPipelineReport(r: ConsensusPipelineReport): string {
  const lines = [
    'CONSENSUS PIPELINE',
    '------------------',
    `Window since:              ${r.windowSinceIso}`,
    `Window until (exclusive):   ${r.windowUntilIso}`,
    `Evaluations:                ${r.evaluations}`,
    `Directional evaluations:    ${r.directionalEvaluations}`,
    `HOLD/DATA_UNAVAILABLE:      ${r.holdCount}`,
    `0-agent agreement:          ${r.independentAgreementCounts['0']}`,
    `1-agent agreement:          ${r.independentAgreementCounts['1']}`,
    `2-agent agreement:          ${r.independentAgreementCounts['2']}`,
    `3-agent agreement:          ${r.independentAgreementCounts['3']}`,
    `4+ agent agreement:         ${r.independentAgreementCounts['4+']}`,
    `Confidence >= 0.60:         ${r.confidenceAtLeast60}`,
    `Confidence >= 0.75:         ${r.confidenceAtLeast75}`,
    `Below required evidence groups: ${r.evidenceDiagnostics.belowRequiredEvidenceGroups} (unknown: ${r.evidenceDiagnostics.independenceUnknown})`,
    `Rounds with calibrated confidence reduction: ${r.evidenceDiagnostics.roundsWithCalibrationReduction}`,
    `Low confidence AND insufficient groups: ${r.evidenceDiagnostics.confidenceBelowStrongAndBelowRequiredGroups}`,
    `Moderate approved:          ${r.moderateEligibleCount}`,
    `Strong approved:            ${r.strongApprovedCount}`,
    `RiskEngine reached:         ${r.riskEngineReached}`,
    `Risk approved:              ${r.riskApproved}`,
    `OMS orders:                 ${r.ordersPlaced}`,
    `Paper fills:                ${r.fillsRecorded}`,
    '',
    'DIRECTIONAL VOTES BY AGENT',
    '--------------------------',
    ...Object.entries(r.directionalVotesByAgent).sort((a, b) => b[1] - a[1]).map(([agent, n]) => `${agent.padEnd(28)}${n}`),
    '',
    'TOP NO-TRADE REASONS',
    '--------------------',
    ...r.topTerminalReasons.map((t) => `${t.code.padEnd(28)}${t.count}`),
    '',
    'TOP RISKENGINE BLOCKING GATES (real, non-replay rejections only)',
    '------------------------------------------------------------------',
    ...(r.topRiskGateRejections.length > 0
      ? r.topRiskGateRejections.map((t) => `${t.gateName.padEnd(32)}${t.count}`)
      : ['(no RiskEngine rejections in this window)']),
  ];
  return lines.join('\n');
}
