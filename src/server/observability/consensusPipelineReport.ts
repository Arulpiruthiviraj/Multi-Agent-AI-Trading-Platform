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
import { and, eq, gte, sql } from 'drizzle-orm';

export interface ConsensusPipelineReport {
  windowSinceIso: string;
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
}

export async function buildConsensusPipelineReport(sinceIso: string): Promise<ConsensusPipelineReport> {
  const rows = await db.select().from(observabilityEvents).where(
    and(eq(observabilityEvents.eventType, 'CONSENSUS_TERMINAL_REASON'), gte(observabilityEvents.ts, new Date(sinceIso).getTime())),
  );

  const parsed = rows.map((r) => {
    try { return JSON.parse(r.payload as string); } catch { return null; }
  }).filter((p): p is Record<string, any> => p !== null);

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

  for (const p of parsed) {
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

  const riskRows = await db.select().from(riskAssessments).where(gte(riskAssessments.createdAt, sinceIso));
  const orderRows = await db.select().from(trades).where(gte(trades.submittedAt, sinceIso));
  const fillRows = await db.select({ id: fills.id }).from(fills).where(gte(fills.filledAt, sinceIso));

  const topTerminalReasons = Array.from(terminalReasonCounts.entries())
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);

  return {
    windowSinceIso: sinceIso,
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
  };
}

export function formatConsensusPipelineReport(r: ConsensusPipelineReport): string {
  const lines = [
    'CONSENSUS PIPELINE',
    '------------------',
    `Window since:              ${r.windowSinceIso}`,
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
  ];
  return lines.join('\n');
}
