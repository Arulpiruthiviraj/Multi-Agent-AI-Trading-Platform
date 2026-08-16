/**
 * Copy diagnostic PENDING trades into diagnostic_trade_archive, then mark the live row
 * ARCHIVED_DIAGNOSTIC. Never DELETE — history stays queryable.
 */
import type { Database as SqliteDatabase } from 'better-sqlite3';

export const ARCHIVED_DIAGNOSTIC_STATUS = 'ARCHIVED_DIAGNOSTIC';

export function isDiagnosticPendingRow(row: {
  status?: string | null;
  traceId?: string | null;
  trace_id?: string | null;
  symbol?: string | null;
}): boolean {
  if (row.status !== 'PENDING') return false;
  const tid = String(row.traceId ?? row.trace_id ?? '');
  const sym = String(row.symbol ?? '');
  return /^diag-/i.test(tid) || /^DIAG/i.test(sym);
}

export function archiveDiagnosticPendingTrades(
  sqlite: SqliteDatabase,
  opts: { apply: boolean; nowIso?: string } = { apply: false },
): { matched: number; archived: number; ids: string[] } {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS diagnostic_trade_archive (
      id TEXT PRIMARY KEY,
      archived_at TEXT NOT NULL,
      original_status TEXT NOT NULL,
      trace_id TEXT,
      symbol TEXT,
      snapshot_json TEXT NOT NULL
    );
  `);

  const rows = sqlite.prepare(`SELECT * FROM trades WHERE status = 'PENDING'`).all() as Array<Record<string, unknown>>;
  const matched = rows.filter((r) => isDiagnosticPendingRow({
    status: String(r.status ?? ''),
    traceId: r.trace_id == null ? null : String(r.trace_id),
    symbol: r.symbol == null ? null : String(r.symbol),
  }));
  const ids = matched.map((r) => String(r.id));
  if (!opts.apply || matched.length === 0) {
    return { matched: matched.length, archived: 0, ids };
  }

  const nowIso = opts.nowIso ?? new Date().toISOString();
  const insert = sqlite.prepare(`
    INSERT OR REPLACE INTO diagnostic_trade_archive (id, archived_at, original_status, trace_id, symbol, snapshot_json)
    VALUES (@id, @archived_at, @original_status, @trace_id, @symbol, @snapshot_json)
  `);
  const update = sqlite.prepare(`UPDATE trades SET status = @status WHERE id = @id`);

  const tx = sqlite.transaction(() => {
    for (const r of matched) {
      insert.run({
        id: String(r.id),
        archived_at: nowIso,
        original_status: String(r.status),
        trace_id: r.trace_id == null ? null : String(r.trace_id),
        symbol: r.symbol == null ? null : String(r.symbol),
        snapshot_json: JSON.stringify(r),
      });
      update.run({ status: ARCHIVED_DIAGNOSTIC_STATUS, id: String(r.id) });
    }
  });
  tx();

  return { matched: matched.length, archived: matched.length, ids };
}
