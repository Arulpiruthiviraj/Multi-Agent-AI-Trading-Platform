import Database from 'better-sqlite3';
import type { LineageRows } from './lineageOracle';

/** Reads the persisted facts of an ISOLATED synthetic session DB (read-only) into the lineage oracle's row shape. */
export function readLineageRows(dbPath: string, pendingWindowMs?: number): LineageRows {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const all = <T>(sql: string) => db.prepare(sql).all() as T[];
    const ideaEvents = all<{ correlation_id: string; timestamp: number; payload: string | null }>(
      "SELECT correlation_id, timestamp, payload FROM event_traces WHERE event_type='TRADE_IDEA_GENERATED' AND correlation_id IS NOT NULL");
    const ideas = ideaEvents.map((e) => {
      let agent = 'UNKNOWN'; let symbol = 'UNKNOWN';
      try { const p = JSON.parse(e.payload ?? '{}'); agent = String(p.agent ?? p.source ?? agent); symbol = String(p.symbol ?? symbol); } catch { /* keep defaults */ }
      return { traceId: e.correlation_id, agent, symbol, atMs: Number(e.timestamp) };
    });
    const tt = all<{ trace_id: string; symbol: string; contributing_agents: string | null }>('SELECT trace_id, symbol, contributing_agents FROM transaction_traces');
    const ttByTrace = new Map(tt.map((r) => [r.trace_id, r]));
    for (const i of ideas) {
      const t = ttByTrace.get(i.traceId);
      if (t && i.symbol === 'UNKNOWN') i.symbol = t.symbol;
      if (t && i.agent === 'UNKNOWN') { try { i.agent = String(JSON.parse(t.contributing_agents ?? '[]')[0] ?? i.agent); } catch { /* keep */ } }
    }
    const endMs = (db.prepare('SELECT MAX(timestamp) AS m FROM event_traces').get() as { m: number | null }).m ?? undefined;
    return {
      ideas,
      endMs: endMs === undefined ? undefined : Number(endMs),
      pendingWindowMs,
      evidenceSourceTraceIds: all<{ s: string }>('SELECT DISTINCT source_trace_id AS s FROM consensus_evidence WHERE source_trace_id IS NOT NULL').map((r) => r.s),
      rejectionTraceIds: all<{ c: string }>("SELECT DISTINCT correlation_id AS c FROM event_traces WHERE event_type IN ('DESK_NO_TRADE','TRADE_IDEA_REJECTED') AND correlation_id IS NOT NULL").map((r) => r.c),
      risk: all<{ trace_id: string; approved: number; transaction_id: string | null }>('SELECT trace_id, approved, transaction_id FROM risk_assessments')
        .map((r) => ({ traceId: r.trace_id, approved: !!r.approved, transactionId: r.transaction_id })),
      trades: all<{ id: string; trace_id: string | null; transaction_id: string | null; side: 'BUY' | 'SELL'; status: string; symbol: string; quantity: number }>(
        'SELECT id, trace_id, transaction_id, side, status, symbol, quantity FROM trades')
        .map((r) => ({ id: r.id, traceId: r.trace_id, transactionId: r.transaction_id, side: r.side, status: r.status, symbol: r.symbol, quantity: r.quantity })),
      fills: all<{ order_id: string; quantity: number }>('SELECT order_id, quantity FROM fills').map((r) => ({ orderId: r.order_id, quantity: r.quantity })),
      openPositions: all<{ symbol: string; quantity: number }>('SELECT symbol, quantity FROM portfolio WHERE quantity <> 0'),
    };
  } finally { db.close(); }
}
