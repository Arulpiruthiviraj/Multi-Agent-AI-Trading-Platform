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
import { observabilityEvents, quantAssessments, riskAssessments, trades, fills } from '../db/schema';
import { and, eq, gte, lt } from 'drizzle-orm';
import { tradingSafety } from '../config/tradingSafety';
import { classifyTradeEnvironment, isReplayTraceId } from '../research/organicPaper';
import { marketDataWorker } from '../services/MarketDataWorker';

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
  windowUntilIso: string | null;
  acknowledgedCount: number;
  capacityDeniedCount: number;
  freshAssessmentQuoteCount: number;
  consensusEvaluationCount: number;
  consensusPersistenceNote: string;
  /** Observed stages only. Trace ids correlate downstream stages; symbol/time alone is not causality. */
  observedTimeline: Array<{ ts: string; stage: string; traceId: string | null; orderId: string | null }>;
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
  /**
   * Live MarketDataWorker snapshot (2026-09-04 opportunity-capture remediation), not a windowed DB
   * query - this is the ONE stage the rest of this report could not previously see: a symbol can
   * have real subscribeRequestedCount > 0 and still never receive a tick, and until this addition
   * that looked identical to "subscribed and just hasn't ticked yet in the window" instead of "IB
   * rejected the market-data line and it will never tick." Null fields mean "not currently in
   * MarketDataWorker's active-stream set" (may have been evicted, or never actually admitted despite
   * a subscribe *request*).
   */
  currentlySubscribed: boolean;
  currentTickCount: number | null;
  currentDwellAgeMs: number | null;
  marketDataError: { code: number; message: string; atMs: number } | null;
  /** Plain-language summary of where this symbol's lineage currently terminates, using only what
   *  was actually observed - never a guess at a stage with zero evidence. */
  terminalSummary: string;
}

export async function buildDiscoveryLineageReport(symbol: string, sinceIso: string, untilIso?: string): Promise<DiscoveryLineageReport> {
  const sym = symbol.trim().toUpperCase();
  const sinceMs = new Date(sinceIso).getTime();
  const untilMs = untilIso ? new Date(untilIso).getTime() : Infinity;
  if (!Number.isFinite(sinceMs) || !(untilMs > sinceMs)) throw new Error('Invalid lineage time window');
  const inWindow = (at: string) => { const ms = new Date(at).getTime(); return ms >= sinceMs && ms < untilMs; };

  const rawEvents = await db.select().from(observabilityEvents).where(
    and(eq(observabilityEvents.symbol, sym), gte(observabilityEvents.ts, sinceMs),
      untilIso ? lt(observabilityEvents.ts, untilMs) : undefined),
  );
  const evRows = rawEvents.filter(r => {
    if (isReplayTraceId(r.traceId)) return false;
    try {
      const p = JSON.parse(r.payload || '{}');
      return !['REPLAY', 'BACKTEST', 'SIMULATION'].includes(p.executionEnvironment ?? p.environment);
    } catch { return true; }
  });
  const payload = (row: typeof evRows[number]): any => { try { return JSON.parse(row.payload || '{}'); } catch { return {}; } };
  const acknowledgedCount = evRows.filter(r => r.eventType === 'IBKR_MARKET_DATA_ACKNOWLEDGED').length;
  const capacityDeniedCount = evRows.filter(r => r.eventType === 'TEMPORARY_DATA_RESCUE_DENIED'
    || r.eventType === 'MARKET_DATA_CAPACITY_FULL').length;
  const freshAssessmentQuoteCount = evRows.filter(r => r.eventType === 'QUANT_QUOTE_EVIDENCE'
    && Number.isFinite(payload(r).quote?.priceAgeMs) && payload(r).quote.priceAgeMs >= 0
    && payload(r).quote.priceAgeMs <= tradingSafety.stalePriceThresholdMs
    && payload(r).quote.observedPrice > 0).length;
  const observedTimeline = evRows.filter(r => !isReplayTraceId(r.traceId) && [
    'DISCOVERY_CANDIDATE_ADMITTED', 'DISCOVERY_CANDIDATE_FILTERED', 'WATCHLIST_SUBSCRIBE_REQUESTED',
    'IBKR_MARKET_DATA_ACKNOWLEDGED', 'TEMPORARY_DATA_RESCUE_DENIED', 'MARKET_DATA_CAPACITY_FULL',
    'QUANT_QUOTE_EVIDENCE', 'TRADE_IDEA_GENERATED', 'CONSENSUS_TERMINAL_REASON', 'ORDER_QUOTE_EVIDENCE',
    'ORDER_POSITION_REFUSED',
  ].includes(r.eventType ?? '')).map(r => ({ ts: new Date(r.ts).toISOString(), stage: r.eventType!,
    traceId: r.traceId ?? payload(r).traceId ?? null, orderId: r.orderId ?? payload(r).orderId ?? null }));

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
    and(eq(quantAssessments.symbol, sym), gte(quantAssessments.createdAt, sinceIso),
      untilIso ? lt(quantAssessments.createdAt, untilIso) : undefined),
  );

  const riskRows = await db.select().from(riskAssessments).where(eq(riskAssessments.symbol, sym));
  const genuineRisk = riskRows.filter((r) => inWindow(r.createdAt as unknown as string) && !isReplayTraceId(r.traceId)
    && !['REPLAY','BACKTEST','SIMULATION'].includes(classifyTradeEnvironment({ reasoning: r.reasoning, traceId: r.traceId })));
  const tradeRows = await db.select().from(trades).where(eq(trades.symbol, sym));
  const genuineTrades = tradeRows.filter((t) => inWindow(t.timestamp) && ['PAPER', 'LIVE'].includes(classifyTradeEnvironment(t)));
  const fillRows = await db.select({ id: fills.id, orderId: fills.orderId, at: fills.filledAt, traceId: trades.traceId,
    executionEnvironment: trades.executionEnvironment, reasoning: trades.reasoning, brokerId: trades.brokerId })
    .from(fills).innerJoin(trades, eq(trades.id, fills.orderId)).where(and(eq(trades.symbol, sym), gte(fills.filledAt, sinceIso),
      untilIso ? lt(fills.filledAt, untilIso) : undefined));
  const genuineFills = fillRows.filter(r => ['PAPER', 'LIVE'].includes(classifyTradeEnvironment(r)));
  for (const r of genuineRisk) observedTimeline.push({ ts: r.createdAt as unknown as string, stage: r.approved ? 'RISK_APPROVED' : 'RISK_REJECTED', traceId: r.traceId, orderId: null });
  for (const t of genuineTrades) observedTimeline.push({ ts: t.timestamp, stage: t.brokerOrderId ? 'BROKER_ORDER_RECORDED' : 'OMS_LEDGER_ROW', traceId: t.traceId, orderId: t.id });
  for (const f of genuineFills) observedTimeline.push({ ts: f.at, stage: 'FILL_RECORDED', traceId: f.traceId, orderId: f.orderId });
  observedTimeline.sort((a,b) => a.ts.localeCompare(b.ts));

  const riskEngineReached = genuineRisk.length > 0;
  const riskApproved = genuineRisk.some((r) => r.approved);
  const omsOrderPlaced = genuineTrades.some(t => !!t.brokerOrderId || !!t.acceptedAt);
  const fillReached = genuineFills.length > 0;

  const liveSlot = marketDataWorker.getActiveSlots().find((s) => s.symbol === sym) ?? null;
  const currentlySubscribed = liveSlot != null;
  const currentTickCount = liveSlot?.tickCount ?? null;
  const currentDwellAgeMs = liveSlot?.dwellAgeMs ?? null;
  const marketDataError = liveSlot?.marketDataError ?? marketDataWorker.getMarketDataError(sym);

  let terminalSummary: string;
  if (fillReached) terminalSummary = 'Reached a real (non-REPLAY) fill.';
  else if (omsOrderPlaced) terminalSummary = 'Reached OMS but no fill recorded in this window.';
  else if (riskEngineReached) terminalSummary = riskApproved ? 'RiskEngine approved but no OMS order recorded.' : 'Rejected by RiskEngine.';
  else if (consensusApprovedCount > 0) terminalSummary = 'Consensus approved but RiskEngine was never reached in this window.';
  else if (consensusRows.length > 0) terminalSummary = `Consensus evaluated but never approved (top reason: ${Object.entries(consensusRejectionReasons).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown'}).`;
  else if (ideaEmittedCount > 0) terminalSummary = 'A trade idea was emitted but never reached a recorded consensus decision in this window.';
  else if (qaRows.length > 0) terminalSummary = 'QuantEngine evaluated this symbol but never emitted a trade idea in this window.';
  else if (marketDataError) terminalSummary = `Currently subscribed but IB rejected the market-data line (code ${marketDataError.code}: ${marketDataError.message}) - it will never tick until this is resolved (commonly a missing market-data-line entitlement for this symbol/exchange).`;
  else if (currentlySubscribed && currentTickCount === 0) terminalSummary = 'Currently subscribed (no market-data error recorded) but has not yet received a real tick.';
  else if (subscribeRequestedCount > 0) terminalSummary = 'Subscription requested but no QuantEngine evaluation recorded in this window; a request alone does not prove receiving fresh data.';
  else if (discoveryDecisions.some((d) => d.admitted)) terminalSummary = 'Admitted by discovery but never reached a recorded subscription request in this window.';
  else if (discoveryDecisions.length > 0) terminalSummary = `Filtered at discovery (${discoveryDecisions[discoveryDecisions.length - 1].reason ?? 'unknown reason'}).`;
  else terminalSummary = 'No discovery-lineage evidence found for this symbol in this window - either it was never scanned by an instrumented discovery source, or it predates Phase A instrumentation (shipped 2026-09-02).';

  return {
    symbol: sym,
    windowSinceIso: sinceIso,
    windowUntilIso: untilIso ?? null,
    acknowledgedCount, capacityDeniedCount, freshAssessmentQuoteCount,
    consensusEvaluationCount: consensusRows.length,
    consensusPersistenceNote: 'Terminal events count evaluations; consensus_decisions aggregates interim rejections at its periodic sweep. These counts are not one-to-one.',
    observedTimeline,
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
    currentlySubscribed,
    currentTickCount,
    currentDwellAgeMs,
    marketDataError,
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
    `Window end (exclusive): ${r.windowUntilIso ?? 'open-ended'}`,
    `Provider acknowledgments: ${r.acknowledgedCount}; capacity/refusal events: ${r.capacityDeniedCount}`,
    `Assessments with persisted fresh quote evidence: ${r.freshAssessmentQuoteCount}`,
    `Consensus evaluation events: ${r.consensusEvaluationCount}. ${r.consensusPersistenceNote}`,
    `Currently subscribed (live): ${r.currentlySubscribed}${r.currentlySubscribed ? ` (tickCount=${r.currentTickCount}, dwellAgeMs=${r.currentDwellAgeMs})` : ''}`,
    `Market-data error (live): ${r.marketDataError ? `code ${r.marketDataError.code}: ${r.marketDataError.message}` : 'none'}`,
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
