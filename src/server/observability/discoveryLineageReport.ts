/**
 * Discovery Lineage Ledger, Phase A (2026-09-01 forensic audit follow-up,
 * docs/audits/ARGUS_UNIVERSAL_DISCOVERY_PAPER_TRADING_FORENSIC_AUDIT_2026-09-01.md §8/§27). Before
 * this phase, a candidate rejected by MarketUniverseScanner.ts's liquidity screen simply vanished
 * with zero record - the exact gap that made a real, externally-verified market mover (FRVO)
 * architecturally unexplainable after the fact. This module answers, for one symbol over a time
 * window: was it seen by discovery, admitted or filtered and why, was it subscribed, how many times
 * was it quant-evaluated, did it emit an idea, what did consensus/risk/OMS do with it.
 *
 * Read-only. Never gates a trade, never writes anything. Discovery-stage data only exists for
 * activity that happened AFTER this phase shipped (2026-09-02) - it cannot retroactively explain an
 * earlier miss like the original FRVO case; it exists so the next one is traceable.
 */
import { db } from '../db';
import { observabilityEvents, quantAssessments, riskAssessments, trades } from '../db/schema';
import { and, eq, gte } from 'drizzle-orm';
import { classifyTradeEnvironment, isReplayTraceId } from '../research/organicPaper';

export interface DiscoveryDecisionEvent {
  ts: string;
  admitted: boolean;
  source: 'BROAD_UNIVERSE' | 'MARKET_MOVER' | string;
  reason: string | null;
  price: number | null;
  dollarVolume: number | null;
  spreadBps: number | null;
  advShares: number | null;
  /** Phase C (Universal Discovery Expansion): true when this candidate's real intraday gap
   *  cleared the reviewed threshold - a genuinely additional discovery signal, not a new source. */
  gapMover: boolean;
  gapPct: number | null;
  /** Phase 27 (Universal Discovery Expansion follow-up): true when this candidate's real
   *  today's-volume/ADV ratio cleared the reviewed threshold - symmetric to gapMover above. */
  rvolMover: boolean;
  rvol: number | null;
}

export interface DiscoveryLineageReport {
  symbol: string;
  windowSinceIso: string;
  discoveryDecisions: DiscoveryDecisionEvent[];
  subscribeRequestedCount: number;
  quantEvaluationCount: number;
  ideaEmittedCount: number;
  consensusApprovedCount: number;
  consensusRejectionReasons: Record<string, number>;
  riskEngineReached: boolean;
  riskApproved: boolean;
  omsOrderPlaced: boolean;
  fillReached: boolean;
  /** Plain-language summary of where this symbol's lineage currently terminates, using only what
   *  was actually observed - never a guess at a stage with zero evidence. */
  terminalSummary: string;
}

export async function buildDiscoveryLineageReport(symbol: string, sinceIso: string): Promise<DiscoveryLineageReport> {
  const sym = symbol.trim().toUpperCase();
  const sinceMs = new Date(sinceIso).getTime();

  const evRows = await db.select().from(observabilityEvents).where(
    and(eq(observabilityEvents.symbol, sym), gte(observabilityEvents.ts, sinceMs)),
  );

  const discoveryDecisions: DiscoveryDecisionEvent[] = evRows
    .filter((r) => r.eventType === 'DISCOVERY_CANDIDATE_ADMITTED' || r.eventType === 'DISCOVERY_CANDIDATE_FILTERED')
    .map((r) => {
      let p: any = {};
      try { p = JSON.parse(r.payload as string); } catch { /* leave empty */ }
      return {
        ts: new Date(r.ts).toISOString(),
        admitted: r.eventType === 'DISCOVERY_CANDIDATE_ADMITTED',
        source: p.source ?? 'UNKNOWN',
        reason: p.reason ?? null,
        price: p.price ?? null,
        dollarVolume: p.dollarVolume ?? null,
        spreadBps: p.spreadBps ?? null,
        advShares: p.advShares ?? null,
        gapMover: p.gapMover ?? false,
        gapPct: p.gapPct ?? null,
        rvolMover: p.rvolMover ?? false,
        rvol: p.rvol ?? null,
      };
    })
    .sort((a, b) => a.ts.localeCompare(b.ts));

  const subscribeRequestedCount = evRows.filter((r) => r.eventType === 'WATCHLIST_SUBSCRIBE_REQUESTED').length;
  const ideaEmittedCount = evRows.filter((r) => r.eventType === 'TRADE_IDEA_GENERATED').length;

  const consensusRows = evRows.filter((r) => r.eventType === 'CONSENSUS_TERMINAL_REASON');
  let consensusApprovedCount = 0;
  const consensusRejectionReasons: Record<string, number> = {};
  for (const r of consensusRows) {
    let p: any = {};
    try { p = JSON.parse(r.payload as string); } catch { /* leave empty */ }
    if (p.approved === true) {
      consensusApprovedCount += 1;
    } else {
      const reason = p.terminalReasonCode ?? p.reasonCode ?? 'unknown';
      consensusRejectionReasons[reason] = (consensusRejectionReasons[reason] ?? 0) + 1;
    }
  }

  const qaRows = await db.select().from(quantAssessments).where(
    and(eq(quantAssessments.symbol, sym), gte(quantAssessments.createdAt, sinceIso)),
  );

  const riskRows = await db.select().from(riskAssessments).where(eq(riskAssessments.symbol, sym));
  const genuineRisk = riskRows.filter((r) => new Date(r.createdAt as unknown as string).getTime() >= sinceMs && !isReplayTraceId(r.traceId));
  const tradeRows = await db.select().from(trades).where(eq(trades.symbol, sym));
  const genuineTrades = tradeRows.filter((t) => new Date(t.timestamp).getTime() >= sinceMs && classifyTradeEnvironment(t) !== 'REPLAY');

  const riskEngineReached = genuineRisk.length > 0;
  const riskApproved = genuineRisk.some((r) => r.approved);
  const omsOrderPlaced = genuineTrades.length > 0;
  const fillReached = genuineTrades.some((t) => t.status === 'FILLED');

  let terminalSummary: string;
  if (fillReached) terminalSummary = 'Reached a real (non-REPLAY) fill.';
  else if (omsOrderPlaced) terminalSummary = 'Reached OMS but no fill recorded in this window.';
  else if (riskEngineReached) terminalSummary = riskApproved ? 'RiskEngine approved but no OMS order recorded.' : 'Rejected by RiskEngine.';
  else if (consensusApprovedCount > 0) terminalSummary = 'Consensus approved but RiskEngine was never reached in this window.';
  else if (consensusRows.length > 0) terminalSummary = `Consensus evaluated but never approved (top reason: ${Object.entries(consensusRejectionReasons).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown'}).`;
  else if (ideaEmittedCount > 0) terminalSummary = 'A trade idea was emitted but never reached a recorded consensus decision in this window.';
  else if (qaRows.length > 0) terminalSummary = 'QuantEngine evaluated this symbol but never emitted a trade idea in this window.';
  else if (subscribeRequestedCount > 0) terminalSummary = 'Subscribed but never reached a recorded QuantEngine evaluation in this window.';
  else if (discoveryDecisions.some((d) => d.admitted)) terminalSummary = 'Admitted by discovery but never reached a recorded subscription request in this window.';
  else if (discoveryDecisions.length > 0) terminalSummary = `Filtered at discovery (${discoveryDecisions[discoveryDecisions.length - 1].reason ?? 'unknown reason'}).`;
  else terminalSummary = 'No discovery-lineage evidence found for this symbol in this window - either it was never scanned by an instrumented discovery source, or it predates Phase A instrumentation (shipped 2026-09-02).';

  return {
    symbol: sym,
    windowSinceIso: sinceIso,
    discoveryDecisions,
    subscribeRequestedCount,
    quantEvaluationCount: qaRows.length,
    ideaEmittedCount,
    consensusApprovedCount,
    consensusRejectionReasons,
    riskEngineReached,
    riskApproved,
    omsOrderPlaced,
    fillReached,
    terminalSummary,
  };
}

export function formatDiscoveryLineageReport(r: DiscoveryLineageReport): string {
  const lines = [
    `DISCOVERY LINEAGE — ${r.symbol}`,
    '-----------------------------------',
    `Window since: ${r.windowSinceIso}`,
    '',
  ];
  if (r.discoveryDecisions.length === 0) {
    lines.push('(no discovery-source admit/filter events recorded for this symbol in this window)');
  } else {
    lines.push('Discovery decisions:');
    for (const d of r.discoveryDecisions) {
      lines.push(`  ${d.ts} ${d.source} ${d.admitted ? 'ADMITTED' : `FILTERED (${d.reason})`} price=${d.price ?? '-'} $vol=${d.dollarVolume ?? '-'} spreadBps=${d.spreadBps ?? '-'} adv=${d.advShares ?? '-'}${d.gapMover ? ` gapMover(${((d.gapPct ?? 0) * 100).toFixed(1)}%)` : ''}${d.rvolMover ? ` rvolMover(${(d.rvol ?? 0).toFixed(1)}x)` : ''}`);
    }
  }
  lines.push(
    '',
    `Subscribe requests: ${r.subscribeRequestedCount}`,
    `Quant evaluations: ${r.quantEvaluationCount}`,
    `Ideas emitted: ${r.ideaEmittedCount}`,
    `Consensus approved: ${r.consensusApprovedCount}`,
    `Consensus rejection reasons: ${JSON.stringify(r.consensusRejectionReasons)}`,
    `RiskEngine reached: ${r.riskEngineReached} (approved: ${r.riskApproved})`,
    `OMS order placed: ${r.omsOrderPlaced}`,
    `Fill reached: ${r.fillReached}`,
    '',
    `TERMINAL SUMMARY: ${r.terminalSummary}`,
  );
  return lines.join('\n');
}
