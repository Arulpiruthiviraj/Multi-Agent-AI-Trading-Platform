import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('dailyLearningArchiveRepository (§14 read-only query API)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let repo: typeof import('./dailyLearningArchiveRepository');
  let orchestrator: typeof import('./DailyCompactionOrchestrator');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_daily_learning_repo_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../index'));
    schema = await import('../schema');
    repo = await import('./dailyLearningArchiveRepository');
    orchestrator = await import('./DailyCompactionOrchestrator');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
  });

  function fakeSource(sourceType: string, rowCount: number) {
    return {
      sourceType,
      schemaVersion: 1,
      async compact(windowStartMs: number, windowEndMs: number, tradingDate: string) {
        return {
          sourceRowCount: rowCount,
          summary: {
            sourceType, tradingDate, schemaVersion: 1,
            windowStart: new Date(windowStartMs).toISOString(), windowEnd: new Date(windowEndMs).toISOString(),
            sourceRowCount: rowCount, eventTypeCounts: { X: rowCount }, categoryCounts: { X: rowCount },
            sections: { discovery: {}, ideas: {}, consensus: {}, risk: {}, orders: {}, marketData: {}, reconciliation: {}, javaBridge: {}, system: {} },
            coverageManifest: { sourceTable: 'fake', windowStartMs, windowEndMs, rowCount, minTs: windowStartMs, maxTs: windowEndMs, eventTypesObserved: ['X'], eventTypesSummarized: [], unknownEventTypes: ['X'] },
          },
        };
      },
      purgeWindow: async () => ({ deleted: 0, truncated: false }),
    };
  }

  it('getDailyLearning returns null for a day that was never compacted, never fabricates a row', async () => {
    const row = await repo.getDailyLearning('1999-01-01', 'REPO_TEST');
    expect(row).toBeNull();
  });

  it('getDailyLearning returns the real, parsed summary for a compacted day', async () => {
    const nowMs = Date.parse('2026-02-10T12:00:00Z');
    await orchestrator.runDailyCompactionForDate(fakeSource('REPO_TEST', 17), '2026-02-01', nowMs);
    const row = await repo.getDailyLearning('2026-02-01', 'REPO_TEST');
    expect(row).not.toBeNull();
    expect(row!.sourceRowCount).toBe(17);
    expect(row!.compactionStatus).toBe('VERIFIED');
    expect(row!.summary?.eventTypeCounts.X).toBe(17);
  });

  it('listDailyLearning returns rows in ascending tradingDate order within the requested range only', async () => {
    const nowMs = Date.parse('2026-02-10T12:00:00Z');
    await orchestrator.runDailyCompactionForDate(fakeSource('REPO_RANGE', 1), '2026-02-02', nowMs);
    await orchestrator.runDailyCompactionForDate(fakeSource('REPO_RANGE', 2), '2026-02-04', nowMs);
    await orchestrator.runDailyCompactionForDate(fakeSource('REPO_RANGE', 3), '2026-02-08', nowMs); // outside range below

    const rows = await repo.listDailyLearning('2026-02-01', '2026-02-05', 'REPO_RANGE');
    expect(rows.map((r) => r.tradingDate)).toEqual(['2026-02-02', '2026-02-04']);
    expect(rows.map((r) => r.sourceRowCount)).toEqual([1, 2]);
  });
});
