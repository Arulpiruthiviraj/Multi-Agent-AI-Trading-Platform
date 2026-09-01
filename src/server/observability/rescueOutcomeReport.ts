/**
 * Phase 14 (2026-08-31 historical-replay & fair-exploration mission), Objective 1's explicit
 * requirement: "record whether the resulting idea reached consensus, whether it reached
 * RiskEngine, whether it produced a paper fill" for every temporary data rescue grant
 * (MarketDataWorker.requestTemporaryDataRescue). Read-only correlation over already-persisted
 * observability_events/risk_assessments/trades rows - never a new decision path, never mutates
 * anything. A rescue grant only buys the symbol a chance at live data on its NEXT evaluation
 * cycle; this report answers, after the fact, whether that chance actually paid off.
 */
import { db } from '../db';
import { observabilityEvents, riskAssessments, trades } from '../db/schema';
import { and, eq, gte, asc } from 'drizzle-orm';

export interface RescueOutcomeRow {
  symbol: string;
  grantedAt: string;
  reason: string;
  /** Real CONSENSUS_TERMINAL_REASON rows for this symbol within the follow-up window. */
  consensusRoundsObserved: number;
  consensusApproved: boolean;
  /** Real risk_assessments rows for this symbol within the follow-up window. */
  riskEngineReached: boolean;
  riskApproved: boolean;
  /** Real FILLED trades for this symbol within the follow-up window. */
  paperFillProduced: boolean;
}

const FOLLOWUP_WINDOW_MS = 30 * 60 * 1000; // generous enough to cover one more evaluation cycle + consensus + risk + OMS round trip

export async function buildRescueOutcomeReport(sinceIso: string): Promise<RescueOutcomeRow[]> {
  const since = new Date(sinceIso).getTime();
  const events = await db.select().from(observabilityEvents)
    .where(and(eq(observabilityEvents.eventType, 'TEMPORARY_DATA_RESCUE_GRANTED'), gte(observabilityEvents.ts, since)))
    .orderBy(asc(observabilityEvents.ts));

  const rows: RescueOutcomeRow[] = [];
  for (const ev of events) {
    if (!ev.symbol) continue;
    const grantedAtMs = ev.ts;
    const windowEndIso = new Date(grantedAtMs + FOLLOWUP_WINDOW_MS).toISOString();
    const grantedAtIso = new Date(grantedAtMs).toISOString();

    const consensusRows = await db.select().from(observabilityEvents).where(
      and(
        eq(observabilityEvents.eventType, 'CONSENSUS_TERMINAL_REASON'),
        eq(observabilityEvents.symbol, ev.symbol),
        gte(observabilityEvents.ts, grantedAtMs),
      ),
    );
    const relevantConsensus = consensusRows.filter((r) => r.ts <= new Date(windowEndIso).getTime());
    let consensusApproved = false;
    for (const r of relevantConsensus) {
      try {
        const payload = JSON.parse(r.payload as string);
        if (payload.approved === true) consensusApproved = true;
      } catch { /* leave false */ }
    }

    const riskRows = await db.select().from(riskAssessments).where(
      and(eq(riskAssessments.symbol, ev.symbol), gte(riskAssessments.createdAt, grantedAtIso)),
    );
    const relevantRisk = riskRows.filter((r) => r.createdAt <= windowEndIso);

    const tradeRows = await db.select().from(trades).where(
      and(eq(trades.symbol, ev.symbol), eq(trades.status, 'FILLED'), gte(trades.timestamp, grantedAtIso)),
    );
    const relevantFills = tradeRows.filter((t) => t.timestamp <= windowEndIso);

    let reason = '';
    try { reason = JSON.parse(ev.payload as string).reasoning ?? ''; } catch { /* leave empty */ }

    rows.push({
      symbol: ev.symbol,
      grantedAt: grantedAtIso,
      reason,
      consensusRoundsObserved: relevantConsensus.length,
      consensusApproved,
      riskEngineReached: relevantRisk.length > 0,
      riskApproved: relevantRisk.some((r) => r.approved),
      paperFillProduced: relevantFills.length > 0,
    });
  }
  return rows;
}

export function formatRescueOutcomeReport(rows: RescueOutcomeRow[]): string {
  const lines = [
    'DATA RESCUE OUTCOMES (did a temporary data-rescue grant actually lead anywhere real?)',
    '----------------------------------------------------------------------------------',
  ];
  if (rows.length === 0) {
    lines.push('(no temporary data rescue grants in this window)');
    return lines.join('\n');
  }
  lines.push('GrantedAt'.padEnd(26) + 'Symbol'.padEnd(9) + 'ConsensusRounds'.padEnd(17) + 'ConsensusApproved'.padEnd(19) + 'RiskEngine'.padEnd(12) + 'RiskApproved'.padEnd(14) + 'PaperFill');
  for (const r of rows) {
    lines.push(
      r.grantedAt.padEnd(26)
      + r.symbol.padEnd(9)
      + String(r.consensusRoundsObserved).padEnd(17)
      + String(r.consensusApproved).padEnd(19)
      + String(r.riskEngineReached).padEnd(12)
      + String(r.riskApproved).padEnd(14)
      + String(r.paperFillProduced),
    );
  }
  return lines.join('\n');
}
