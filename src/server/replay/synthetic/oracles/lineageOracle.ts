/**
 * lineageOracle.ts - every organically generated idea must end in an EXPLICIT terminal fate; nothing may disappear between components.
 *
 * Terminal fates an idea can legitimately have (derived only from persisted rows, never from in-memory state):
 *   CONSENSUS_EVIDENCE   - persisted as evidence of a consensus decision (approved or NO_CONSENSUS) via consensus_evidence.source_trace_id
 *   EXPLICIT_REJECTION   - a TRADE_IDEA_REJECTED / DESK_NO_TRADE event carries its correlation id
 *   SUPERSEDED           - a later idea from the SAME agent for the SAME symbol replaced it before any round used it (ChiefTrader keeps the
 *                          latest per agent+symbol by design); derivable from the idea stream itself
 *   ORDER_CHAIN          - it is itself the trace of a risk assessment / order
 * An idea with none of these is UNTERMINATED: a real observability hole (or a lost idea).
 *
 * For ideas that produced an order, the full chain is additionally required:
 *   idea -> CHIEF_APPROVED -> risk_assessment(approved) -> trades(order) -> fills -> (portfolio); and net filled quantity per symbol
 *   must equal the open portfolio quantity. Pure over plain row arrays.
 */
export interface LineageRows {
  ideas: Array<{ traceId: string; agent: string; symbol: string; atMs: number }>;
  evidenceSourceTraceIds: string[];
  rejectionTraceIds: string[];
  risk: Array<{ traceId: string; approved: boolean; transactionId: string | null }>;
  trades: Array<{ id: string; traceId: string | null; transactionId: string | null; side: 'BUY' | 'SELL'; status: string; symbol: string; quantity: number }>;
  fills: Array<{ orderId: string; quantity: number }>;
  openPositions: Array<{ symbol: string; quantity: number }>;
  /** Last persisted event time and the longest an idea may legitimately wait for its consensus sweep. An idea younger than this at
   *  session end is PENDING_AT_END (the sweep had not fired yet), reported separately and never silently counted as terminated. */
  endMs?: number;
  pendingWindowMs?: number;
}

export type IdeaFate = 'CONSENSUS_EVIDENCE' | 'EXPLICIT_REJECTION' | 'SUPERSEDED' | 'ORDER_CHAIN' | 'PENDING_AT_END' | 'UNTERMINATED';
export interface LineageViolation { code: string; detail: string }
export interface LineageResult { fates: Record<IdeaFate, number>; unterminated: string[]; violations: LineageViolation[] }

export function runLineageOracle(rows: LineageRows): LineageResult {
  const evidence = new Set(rows.evidenceSourceTraceIds);
  const rejected = new Set(rows.rejectionTraceIds);
  const riskTraces = new Set(rows.risk.map((r) => r.traceId));
  const tradeTraces = new Set(rows.trades.map((t) => t.traceId).filter((x): x is string => !!x));
  const lastByKey = new Map<string, number>();
  for (const i of rows.ideas) lastByKey.set(`${i.agent}|${i.symbol}`, Math.max(lastByKey.get(`${i.agent}|${i.symbol}`) ?? 0, i.atMs));

  const fates: Record<IdeaFate, number> = { CONSENSUS_EVIDENCE: 0, EXPLICIT_REJECTION: 0, SUPERSEDED: 0, ORDER_CHAIN: 0, PENDING_AT_END: 0, UNTERMINATED: 0 };
  const unterminated: string[] = [];
  const violations: LineageViolation[] = [];

  for (const i of rows.ideas) {
    let fate: IdeaFate;
    if (evidence.has(i.traceId)) fate = 'CONSENSUS_EVIDENCE';
    else if (rejected.has(i.traceId)) fate = 'EXPLICIT_REJECTION';
    else if (riskTraces.has(i.traceId) || tradeTraces.has(i.traceId)) fate = 'ORDER_CHAIN';
    else if ((lastByKey.get(`${i.agent}|${i.symbol}`) ?? 0) > i.atMs) fate = 'SUPERSEDED';
    else if (rows.endMs !== undefined && rows.pendingWindowMs !== undefined && rows.endMs - i.atMs <= rows.pendingWindowMs) fate = 'PENDING_AT_END';
    else fate = 'UNTERMINATED';
    fates[fate]++;
    if (fate === 'UNTERMINATED') {
      unterminated.push(i.traceId);
      violations.push({ code: 'IDEA_UNTERMINATED', detail: `${i.traceId} ${i.agent} ${i.symbol}: no consensus evidence, rejection, supersession or order chain` });
    }
  }

  const filledByOrder = new Map<string, number>();
  for (const f of rows.fills) filledByOrder.set(f.orderId, (filledByOrder.get(f.orderId) ?? 0) + f.quantity);
  const riskByTxn = new Map(rows.risk.filter((r) => r.transactionId).map((r) => [r.transactionId as string, r]));

  for (const t of rows.trades) {
    const filled = filledByOrder.get(t.id) ?? 0;
    if (t.status === 'FILLED' && !(filled > 0)) violations.push({ code: 'FILLED_ORDER_WITHOUT_FILL', detail: `${t.side} ${t.symbol} order ${t.id} is FILLED with no fill row` });
    if (filled > 0 && t.status !== 'FILLED' && t.status !== 'PARTIALLY_FILLED') violations.push({ code: 'FILL_ON_NON_FILLED_ORDER', detail: `${t.side} ${t.symbol} order ${t.id} status ${t.status} has fill rows` });
    if (t.side === 'BUY') {
      const risk = (t.transactionId && riskByTxn.get(t.transactionId)) || (t.traceId ? rows.risk.find((r) => r.traceId === t.traceId) : undefined);
      if (!risk) violations.push({ code: 'BUY_WITHOUT_RISK_ASSESSMENT', detail: `BUY ${t.symbol} order ${t.id} has no risk assessment` });
      else if (!risk.approved) violations.push({ code: 'BUY_AFTER_RISK_REJECTION', detail: `BUY ${t.symbol} order ${t.id} exists although its risk assessment was rejected` });
    }
  }

  const net = new Map<string, number>();
  for (const t of rows.trades) {
    const q = filledByOrder.get(t.id) ?? 0;
    net.set(t.symbol, (net.get(t.symbol) ?? 0) + (t.side === 'BUY' ? q : -q));
  }
  const open = new Map(rows.openPositions.map((p) => [p.symbol, p.quantity]));
  for (const sym of new Set([...net.keys(), ...open.keys()])) {
    const n = Math.round((net.get(sym) ?? 0) * 1e9) / 1e9;
    const o = open.get(sym) ?? 0;
    if (Math.abs(n - o) > 1e-9) violations.push({ code: 'POSITION_NOT_EXPLAINED_BY_FILLS', detail: `${sym}: net filled ${n} vs open position ${o}` });
  }
  return { fates, unterminated, violations };
}
