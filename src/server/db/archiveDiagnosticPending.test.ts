import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { archiveDiagnosticPendingTrades, isDiagnosticPendingRow, ARCHIVED_DIAGNOSTIC_STATUS } from './archiveDiagnosticPending';

describe('archiveDiagnosticPending', () => {
  it('matches only diagnostic PENDING rows', () => {
    expect(isDiagnosticPendingRow({ status: 'PENDING', traceId: 'diag-abc', symbol: 'AAPL' })).toBe(true);
    expect(isDiagnosticPendingRow({ status: 'PENDING', traceId: 'live-1', symbol: 'DIAGTEST' })).toBe(true);
    expect(isDiagnosticPendingRow({ status: 'PENDING', traceId: 'organic-1', symbol: 'AAPL' })).toBe(false);
    expect(isDiagnosticPendingRow({ status: 'FILLED', traceId: 'diag-abc', symbol: 'AAPL' })).toBe(false);
  });

  it('copies then marks ARCHIVED_DIAGNOSTIC and never deletes', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE trades (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        quantity REAL NOT NULL,
        price REAL NOT NULL,
        status TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        reasoning TEXT,
        trace_id TEXT
      );
    `);
    sqlite.prepare(`INSERT INTO trades VALUES (?,?,?,?,?,?,?,?,?)`).run(
      'keep-1', 'AAPL', 'BUY', 1, 10, 'PENDING', '2026-08-16T00:00:00.000Z', 'real', 'organic-1',
    );
    sqlite.prepare(`INSERT INTO trades VALUES (?,?,?,?,?,?,?,?,?)`).run(
      'diag-1', 'NVDA', 'BUY', 1, 10, 'PENDING', '2026-08-16T00:00:00.000Z', 'probe', 'diag-xyz',
    );

    const dry = archiveDiagnosticPendingTrades(sqlite, { apply: false });
    expect(dry.matched).toBe(1);
    expect(dry.archived).toBe(0);
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM trades`).get() as { n: number }).toEqual({ n: 2 });

    const applied = archiveDiagnosticPendingTrades(sqlite, { apply: true, nowIso: '2026-08-16T12:00:00.000Z' });
    expect(applied.archived).toBe(1);
    const diag = sqlite.prepare(`SELECT status FROM trades WHERE id = 'diag-1'`).get() as { status: string };
    expect(diag.status).toBe(ARCHIVED_DIAGNOSTIC_STATUS);
    const keep = sqlite.prepare(`SELECT status FROM trades WHERE id = 'keep-1'`).get() as { status: string };
    expect(keep.status).toBe('PENDING');
    const archived = sqlite.prepare(`SELECT snapshot_json FROM diagnostic_trade_archive WHERE id = 'diag-1'`).get() as { snapshot_json: string };
    expect(JSON.parse(archived.snapshot_json).trace_id).toBe('diag-xyz');
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM trades`).get() as { n: number }).toEqual({ n: 2 });
  });
});
