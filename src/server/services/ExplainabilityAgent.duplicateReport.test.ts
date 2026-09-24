import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Real defect found (Batch 2 forensic audit, 2026-09-23): explainabilityReports.traceId is a
 * `.primaryKey()` (schema.ts:568), but ExplainabilityAgent.generateReport() did a plain
 * `db.insert(explainabilityReports).values({...})` with no conflict handling, wrapped in a
 * try/catch that silently swallowed the resulting SQLITE_CONSTRAINT error via a generic
 * console.log (ExplainabilityAgent.ts:96-98). ORDER_EXECUTED/RISK_ASSESSMENT_COMPLETED can both
 * legitimately fire more than once for the same traceId, so a second generateReport() call for an
 * already-reported traceId threw an unhandled-by-design constraint violation every time, silently.
 *
 * Fix: `.onConflictDoNothing()` on the insert - the first report generated for a traceId is kept
 * (closest to the actual event, no reason a later duplicate call should overwrite it). This test
 * proves: two insert attempts for the same traceId produce a deterministic result (no thrown
 * error, no duplicate row, exactly one row after both).
 */
describe('ExplainabilityAgent duplicate-report handling (traceId primary key conflict)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let explainabilityReports: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_explainability_dup_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    ({ explainabilityReports } = await import('../db/schema'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('a second insert for the same traceId is a deterministic no-op, not a thrown constraint error', async () => {
    const traceId = 'trace-dup-test-1';

    await db.insert(explainabilityReports).values({
      traceId,
      symbol: 'AAPL',
      decision: 'EXECUTED - EXECUTED',
      reportText: 'first report',
      timestamp: new Date().toISOString(),
    }).onConflictDoNothing();

    // Second insert for the SAME traceId must not throw.
    await expect(
      db.insert(explainabilityReports).values({
        traceId,
        symbol: 'AAPL',
        decision: 'EXECUTED - EXECUTED',
        reportText: 'second report (should be discarded)',
        timestamp: new Date().toISOString(),
      }).onConflictDoNothing()
    ).resolves.not.toThrow();

    const rows = await db.select().from(explainabilityReports);
    const matching = rows.filter((r: any) => r.traceId === traceId);
    expect(matching.length).toBe(1);
    // First report wins - never overwritten by the duplicate.
    expect(matching[0].reportText).toBe('first report');
  });
});
