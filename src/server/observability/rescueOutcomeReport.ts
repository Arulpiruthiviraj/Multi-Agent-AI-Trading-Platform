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
import { and, eq, gte, asc, inArray } from 'drizzle-orm';
import { classifyTradeEnvironment, isReplayTraceId } from '../research/organicPaper';

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

  // 2026-10-14 freeze fix (docs: ARGUS_REPORT_FREEZE_2026-10-14): this used to run THREE synchronous better-sqlite3 queries per grant
  // (N+1). With thousands of renewals in a normal session that blocked the engine event loop for minutes (watchdog FROZEN_CONFIRMED at
  // 12:54 ET). Now exactly three queries total, grouped in memory; per-grant semantics (follow-up window, replay exclusion) are unchanged.
  const granted = events.filter((ev) => !!ev.symbol);
  const rows: RescueOutcomeRow[] = [];
  if (granted.length === 0) return rows;
  const symbols = [...new Set(granted.map((ev) => ev.symbol as string))];
  const minGrantMs = granted[0].ts; // events are ordered ascending by ts
  const minGrantIso = new Date(minGrantMs).toISOString();
  const consensusBySymbol = new Map<string, Array<{ ts: number; payload: unknown }>>();
  const riskBySymbol = new Map<string, Array<{ createdAt: string; approved: unknown; traceId: string | null }>>();
  const fillsBySymbol = new Map<string, Array<any>>();
  const CHUNK = 500; // stay well under SQLite's bound-variable limit
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const chunk = symbols.slice(i, i + CHUNK);
    const consensusAll = await db.select().from(observabilityEvents).where(
      and(eq(observabilityEvents.eventType, 'CONSENSUS_TERMINAL_REASON'), inArray(observabilityEvents.symbol, chunk), gte(observabilityEvents.ts, minGrantMs)),
    );
    for (const r of consensusAll) { const k = r.symbol as string; (consensusBySymbol.get(k) ?? consensusBySymbol.set(k, []).get(k)!).push({ ts: r.ts, payload: r.payload }); }
    const riskAll = await db.select().from(riskAssessments).where(and(inArray(riskAssessments.symbol, chunk), gte(riskAssessments.createdAt, minGrantIso)));
    for (const r of riskAll) (riskBySymbol.get(r.symbol) ?? riskBySymbol.set(r.symbol, []).get(r.symbol)!).push(r as any);
    const tradesAll = await db.select().from(trades).where(and(inArray(trades.symbol, chunk), eq(trades.status, 'FILLED'), gte(trades.timestamp, minGrantIso)));
    for (const t of tradesAll) (fillsBySymbol.get(t.symbol) ?? fillsBySymbol.set(t.symbol, []).get(t.symbol)!).push(t);
  }

  for (const ev of granted) {
    const symbol = ev.symbol as string;
    const grantedAtMs = ev.ts;
    const windowEndMs = grantedAtMs + FOLLOWUP_WINDOW_MS;
    const windowEndIso = new Date(windowEndMs).toISOString();
    const grantedAtIso = new Date(grantedAtMs).toISOString();

    const relevantConsensus = (consensusBySymbol.get(symbol) ?? []).filter((r) => r.ts >= grantedAtMs && r.ts <= windowEndMs);
    let consensusApproved = false;
    for (const r of relevantConsensus) {
      try {
        const payload = JSON.parse(r.payload as string);
        if (payload.approved === true) consensusApproved = true;
      } catch { /* leave false */ }
    }

    // Real defect found 2026-09-01: a rescue grant could be falsely correlated to an unrelated HISTORICAL_REPLAY run that touched the
    // same symbol inside the follow-up window - replay traces and replay fills stay excluded.
    const relevantRisk = (riskBySymbol.get(symbol) ?? []).filter((r) => r.createdAt >= grantedAtIso && r.createdAt <= windowEndIso && !isReplayTraceId(r.traceId as any));
    const relevantFills = (fillsBySymbol.get(symbol) ?? []).filter((t) => t.timestamp >= grantedAtIso && t.timestamp <= windowEndIso && classifyTradeEnvironment(t) !== 'REPLAY');

    let reason = '';
    try { reason = JSON.parse(ev.payload as string).reasoning ?? ''; } catch { /* leave empty */ }

    rows.push({
      symbol,
      grantedAt: grantedAtIso,
      reason,
      consensusRoundsObserved: relevantConsensus.length,
      consensusApproved,
      riskEngineReached: relevantRisk.length > 0,
      riskApproved: relevantRisk.some((r) => !!r.approved),
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
