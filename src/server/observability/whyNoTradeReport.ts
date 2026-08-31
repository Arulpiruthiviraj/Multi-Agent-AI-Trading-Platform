/**
 * Phase 9 (2026-08-31) - "why-no-trade" single-candidate explainer. Reuses the same real
 * CONSENSUS_TERMINAL_REASON rows consensusPipelineReport.ts aggregates, but for ONE symbol (or
 * the most recent evaluation of any symbol) joins the downstream risk_assessments/risk_gate_results
 * rows by traceId so a single candidate's full chain - agent votes, independence, consensus,
 * RiskEngine gate outcome - is answerable in one call. Never a new evaluation path; purely reads
 * what the real pipeline already persisted.
 */
import { db } from '../db';
import { observabilityEvents, riskAssessments, riskGateResults } from '../db/schema';
import { eq, desc, and } from 'drizzle-orm';
import { getCandidate } from '../continuous/candidateLifecycle';

export interface WhyNoTradeReport {
  symbol: string | null;
  found: boolean;
  traceId: string | null;
  candidateState: string | null;
  decisionTier: string | null;
  approved: boolean | null;
  terminalReasonCode: string | null;
  rawConfidence: number | null;
  finalConfidence: number | null;
  independentAgentCount: number | null;
  participatingAgents: Array<{ agent: string; side: string; confidence: number }>;
  risk: {
    reached: boolean;
    approved: boolean | null;
    rejectionGate: string | null;
    gateResults: Array<{ gateName: string; passed: boolean; detail: string | null }>;
  };
}

// Filters by eventType at the SQL level (not just symbol, then in-memory .find over a capped
// window) - noisier event types (ticks, subscriptions) for an actively-scanned symbol can easily
// outnumber its real CONSENSUS_TERMINAL_REASON rows within any small in-memory window, which would
// silently hide a real historical evaluation behind a false "not found".
export async function buildWhyNoTradeReport(symbol?: string): Promise<WhyNoTradeReport> {
  const whereClause = symbol
    ? and(eq(observabilityEvents.eventType, 'CONSENSUS_TERMINAL_REASON'), eq(observabilityEvents.symbol, symbol.toUpperCase()))
    : eq(observabilityEvents.eventType, 'CONSENSUS_TERMINAL_REASON');
  const rows = await db.select().from(observabilityEvents)
    .where(whereClause)
    .orderBy(desc(observabilityEvents.ts)).limit(1);

  const row = rows[0];
  if (!row) {
    return {
      symbol: symbol ? symbol.toUpperCase() : null,
      found: false,
      traceId: null,
      candidateState: symbol ? getCandidate(symbol)?.state ?? null : null,
      decisionTier: null,
      approved: null,
      terminalReasonCode: null,
      rawConfidence: null,
      finalConfidence: null,
      independentAgentCount: null,
      participatingAgents: [],
      risk: { reached: false, approved: null, rejectionGate: null, gateResults: [] },
    };
  }

  let payload: Record<string, any> = {};
  try { payload = JSON.parse(row.payload as string); } catch { /* leave empty */ }

  const resolvedSymbol = (row.symbol ?? payload.symbol ?? symbol ?? '').toUpperCase() || null;
  const traceId = row.traceId ?? payload.traceId ?? null;

  let riskRow: typeof riskAssessments.$inferSelect | undefined;
  let gateRows: Array<{ gateName: string; passed: boolean; detail: string | null }> = [];
  if (traceId) {
    const [r] = await db.select().from(riskAssessments).where(eq(riskAssessments.traceId, traceId)).limit(1);
    riskRow = r;
    if (riskRow) {
      const gates = await db.select().from(riskGateResults).where(eq(riskGateResults.traceId, traceId)).orderBy(riskGateResults.sequence);
      gateRows = gates.map((g) => ({ gateName: g.gateName, passed: !!g.passed, detail: g.detail }));
    }
  }

  return {
    symbol: resolvedSymbol,
    found: true,
    traceId,
    candidateState: resolvedSymbol ? getCandidate(resolvedSymbol)?.state ?? null : null,
    decisionTier: payload.decisionTier ?? null,
    approved: typeof payload.approved === 'boolean' ? payload.approved : null,
    terminalReasonCode: payload.terminalReasonCode ?? null,
    rawConfidence: typeof payload.rawConfidence === 'number' ? payload.rawConfidence : null,
    finalConfidence: typeof payload.finalConfidence === 'number' ? payload.finalConfidence : null,
    independentAgentCount: typeof payload.independentAgentCount === 'number' ? payload.independentAgentCount : null,
    participatingAgents: Array.isArray(payload.participatingAgents) ? payload.participatingAgents : [],
    risk: {
      reached: !!riskRow,
      approved: riskRow ? !!riskRow.approved : null,
      rejectionGate: riskRow?.rejectionGate ?? null,
      gateResults: gateRows,
    },
  };
}

export function formatWhyNoTradeReport(r: WhyNoTradeReport): string {
  if (!r.found) {
    return [
      `Symbol: ${r.symbol ?? '(most recent)'}`,
      '',
      r.candidateState ? `Candidate lifecycle state: ${r.candidateState}` : 'No candidate lifecycle record found.',
      'No CONSENSUS_TERMINAL_REASON evaluation found for this symbol.',
    ].join('\n');
  }

  const lines = [
    `Symbol: ${r.symbol}`,
    `Trace: ${r.traceId ?? '(none)'}`,
    r.candidateState ? `Candidate: ${r.candidateState}` : '',
    '',
  ];
  for (const a of r.participatingAgents) {
    lines.push(`${a.agent}: ${a.side} ${typeof a.confidence === 'number' ? a.confidence.toFixed(3) : a.confidence}`);
  }
  lines.push('');
  lines.push(`Independent agreement: ${r.independentAgentCount ?? 0}`);
  lines.push(`Decision tier: ${r.decisionTier ?? 'N/A'}`);
  lines.push(`Consensus: ${r.approved ? 'PASS' : 'FAIL'} (${r.terminalReasonCode ?? 'UNKNOWN'})`);
  lines.push(`Raw confidence: ${r.rawConfidence ?? 'N/A'}   Final confidence: ${r.finalConfidence ?? 'N/A'}`);
  lines.push('');
  if (r.risk.reached) {
    lines.push(`RiskEngine: ${r.risk.approved ? 'PASS' : 'FAIL'}${r.risk.rejectionGate ? ` (${r.risk.rejectionGate})` : ''}`);
    for (const g of r.risk.gateResults) {
      lines.push(`  ${g.gateName.padEnd(28)}${g.passed ? 'PASS' : 'FAIL'}`);
    }
  } else {
    lines.push('RiskEngine: NOT REACHED (no consensus approval for this evaluation)');
  }
  lines.push('');
  lines.push(`Final: ${r.approved && r.risk.approved ? 'TRADE' : 'NO_TRADE'}`);
  return lines.join('\n');
}
