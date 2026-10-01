import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { DailyCompactionSource, DailyCompactionSummary, SourceCompactionResult } from './types';

/**
 * Daily Learning Compaction, Phase 1 - real integration tests against an isolated temp SQLite DB
 * (never data/argus.db - the mandate's own explicit requirement). A fully controllable FAKE
 * DailyCompactionSource is used for most scenarios here so compact()/purgeWindow() failure modes,
 * checksum/row-count tampering, and crash-recovery states can be constructed deterministically;
 * observabilityEventsSource.test.ts separately proves the real observability_events compactor.
 *
 * Critical assertion this whole file exists to prove: NO test may pass if raw data can be deleted
 * without VERIFIED archive state - every purge-related test below explicitly asserts the fake
 * source's raw store either was or was not touched, never just the archive row's status.
 */
describe('DailyCompactionOrchestrator', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let orchestrator: typeof import('./DailyCompactionOrchestrator');
  let tradingDayWindow: typeof import('./tradingDayWindow');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_daily_compaction_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../index'));
    schema = await import('../schema');
    orchestrator = await import('./DailyCompactionOrchestrator');
    tradingDayWindow = await import('./tradingDayWindow');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
  });

  beforeEach(() => {
    db.delete(schema.dailyLearningArchive).run();
  });

  // A real, closed, calendar day far enough in the past that it's never treated as "today" or
  // "not yet closed" regardless of when this suite runs.
  const CLOSED_DATE = '2026-01-05';
  const nowMs = Date.parse('2026-01-10T12:00:00Z');

  /** Builds a fully controllable fake source. `rawRowCount` simulates how many "real" rows this
   *  source holds for the window; purgeWindow() decrements it for real, so tests can assert actual
   *  deletion happened (or didn't) - not just archive-row status. */
  function makeFakeSource(opts: {
    sourceType?: string;
    rowCount?: number;
    badEventTypeSum?: boolean; // simulates a buggy compactor: eventTypeCounts don't sum to rowCount
    compactThrows?: Error;
    purgeThrows?: Error;
  } = {}): { source: DailyCompactionSource; rawRemaining: () => number } {
    let raw = opts.rowCount ?? 10;
    const source: DailyCompactionSource = {
      sourceType: opts.sourceType ?? 'FAKE_SOURCE',
      schemaVersion: 1,
      async compact(windowStartMs, windowEndMs, tradingDate): Promise<SourceCompactionResult> {
        if (opts.compactThrows) throw opts.compactThrows;
        const summary: DailyCompactionSummary = {
          sourceType: opts.sourceType ?? 'FAKE_SOURCE',
          tradingDate,
          schemaVersion: 1,
          windowStart: new Date(windowStartMs).toISOString(),
          windowEnd: new Date(windowEndMs).toISOString(),
          sourceRowCount: raw,
          eventTypeCounts: { FAKE_EVENT: opts.badEventTypeSum ? raw + 999 : raw },
          categoryCounts: { FAKE: raw },
          sections: {
            discovery: {}, ideas: {}, consensus: {}, risk: {}, orders: {},
            marketData: {}, reconciliation: {}, javaBridge: {}, system: {},
          },
          coverageManifest: {
            sourceTable: 'fake_table', windowStartMs, windowEndMs, rowCount: raw,
            minTs: windowStartMs, maxTs: windowEndMs, eventTypesObserved: ['FAKE_EVENT'],
            eventTypesSummarized: [], unknownEventTypes: ['FAKE_EVENT'],
          },
        };
        return { sourceRowCount: raw, summary };
      },
      purgeWindow(): number {
        if (opts.purgeThrows) throw opts.purgeThrows;
        const deleted = raw;
        raw = 0;
        return deleted;
      },
    };
    return { source, rawRemaining: () => raw };
  }

  it('normal successful compaction reaches VERIFIED with real, internally-consistent data', async () => {
    const { source } = makeFakeSource({ sourceType: 'T1', rowCount: 42 });
    const outcome = await orchestrator.runDailyCompactionForDate(source, CLOSED_DATE, nowMs);
    expect(outcome.status).toBe('VERIFIED');
    const row = db.select().from(schema.dailyLearningArchive).all()[0];
    expect(row.sourceRowCount).toBe(42);
    expect(row.compactionStatus).toBe('VERIFIED');
    expect(row.verifiedAt).not.toBeNull();
  });

  it('zero-event day compacts and verifies cleanly (sourceRowCount: 0 is not an error)', async () => {
    const { source } = makeFakeSource({ sourceType: 'T2', rowCount: 0 });
    const outcome = await orchestrator.runDailyCompactionForDate(source, CLOSED_DATE, nowMs);
    expect(outcome.status).toBe('VERIFIED');
    const row = db.select().from(schema.dailyLearningArchive).all()[0];
    expect(row.sourceRowCount).toBe(0);
  });

  it('thousands of events still compacts to a single VERIFIED row (count only, not per-row storage)', async () => {
    const { source } = makeFakeSource({ sourceType: 'T3', rowCount: 25_000 });
    const outcome = await orchestrator.runDailyCompactionForDate(source, CLOSED_DATE, nowMs);
    expect(outcome.status).toBe('VERIFIED');
    expect(db.select().from(schema.dailyLearningArchive).all()).toHaveLength(1);
  });

  it('unknown event type is counted but surfaced, never silently dropped', async () => {
    const { source } = makeFakeSource({ sourceType: 'T4', rowCount: 5 });
    await orchestrator.runDailyCompactionForDate(source, CLOSED_DATE, nowMs);
    const row = db.select().from(schema.dailyLearningArchive).all()[0];
    const summary = JSON.parse(row.summaryJson);
    expect(summary.coverageManifest.unknownEventTypes).toContain('FAKE_EVENT');
    expect(summary.eventTypeCounts.FAKE_EVENT).toBe(5); // still fully counted
  });

  it('duplicate compaction run is idempotent - re-running a VERIFIED day creates no duplicate row and is a real no-op', async () => {
    const { source } = makeFakeSource({ sourceType: 'T5', rowCount: 7 });
    const first = await orchestrator.runDailyCompactionForDate(source, CLOSED_DATE, nowMs);
    const second = await orchestrator.runDailyCompactionForDate(source, CLOSED_DATE, nowMs);
    expect(first.status).toBe('VERIFIED');
    expect(second.status).toBe('VERIFIED');
    expect(db.select().from(schema.dailyLearningArchive).all()).toHaveLength(1); // unique index holds
  });

  it('checksum mismatch (tampered summary_json) fails verification and blocks purge eligibility', async () => {
    const { source } = makeFakeSource({ sourceType: 'T6', rowCount: 3 });
    await orchestrator.runDailyCompactionForDate(source, CLOSED_DATE, nowMs);
    // Tamper the persisted JSON without updating the checksum - simulates corruption.
    sqliteDb.prepare(`UPDATE daily_learning_archive SET summary_json = REPLACE(summary_json, '"sourceRowCount":3', '"sourceRowCount":4') WHERE source_type = 'T6'`).run();
    const outcome = orchestrator.verifyArchiveRow(source, CLOSED_DATE, nowMs);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toMatch(/checksum mismatch/);
    const row = db.select().from(schema.dailyLearningArchive).all()[0];
    expect(row.compactionStatus).toBe('FAILED');
  });

  it('row-count mismatch (eventTypeCounts does not sum to sourceRowCount) fails verification', async () => {
    const { source } = makeFakeSource({ sourceType: 'T7', rowCount: 10, badEventTypeSum: true });
    const outcome = await orchestrator.runDailyCompactionForDate(source, CLOSED_DATE, nowMs);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toMatch(/EVENT_TYPE_SUM_MISMATCH/);
    const row = db.select().from(schema.dailyLearningArchive).all()[0];
    expect(row.compactionStatus).toBe('FAILED');
  });

  it('malformed payload (invalid JSON on read-back) fails verification rather than crashing', async () => {
    const { source } = makeFakeSource({ sourceType: 'T8', rowCount: 1 });
    await orchestrator.runDailyCompactionForDate(source, CLOSED_DATE, nowMs);
    sqliteDb.prepare(`UPDATE daily_learning_archive SET summary_json = 'not valid json {{{' WHERE source_type = 'T8'`).run();
    const outcome = orchestrator.verifyArchiveRow(source, CLOSED_DATE, nowMs);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toMatch(/not valid JSON/);
  });

  it('archive write failure (compact() throws) keeps raw data untouched and marks FAILED, not VERIFIED', async () => {
    const { source, rawRemaining } = makeFakeSource({ sourceType: 'T9', rowCount: 99, compactThrows: new Error('simulated disk full') });
    const outcome = await orchestrator.runDailyCompactionForDate(source, CLOSED_DATE, nowMs);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toMatch(/COMPACTION_FAILED/);
    expect(rawRemaining()).toBe(99); // raw data never touched
  });

  it('purge failure (purgeWindow() throws) leaves the archive row VERIFIED and raw data untouched - not silently PURGED', async () => {
    const { source, rawRemaining } = makeFakeSource({ sourceType: 'T10', rowCount: 50 });
    await orchestrator.runDailyCompactionForDate(source, CLOSED_DATE, nowMs);
    // Re-wrap purgeWindow to throw, simulating a failure discovered only at purge time.
    const throwingSource: DailyCompactionSource = { ...source, purgeWindow: () => { throw new Error('simulated purge failure'); } };
    const farFuture = nowMs + 400 * 24 * 60 * 60 * 1000; // well past any retention window
    const result = orchestrator.purgeVerifiedDays(throwingSource, 14, farFuture);
    expect(result.purgedDays).toBe(0);
    expect(rawRemaining()).toBe(50); // raw data never touched
    const row = db.select().from(schema.dailyLearningArchive).all()[0];
    expect(row.compactionStatus).toBe('VERIFIED'); // not silently flipped to PURGED
  });

  it('crash between compact and verify: a row left COMPACTED (never reached VERIFIED) is safely re-verified on the next attempt', async () => {
    const { source } = makeFakeSource({ sourceType: 'T11', rowCount: 4 });
    const { windowStartMs, windowEndMs } = tradingDayWindow.getTradingDateWindowMs(CLOSED_DATE);
    const summary: DailyCompactionSummary = {
      sourceType: 'T11', tradingDate: CLOSED_DATE, schemaVersion: 1,
      windowStart: new Date(windowStartMs).toISOString(), windowEnd: new Date(windowEndMs).toISOString(),
      sourceRowCount: 4, eventTypeCounts: { X: 4 }, categoryCounts: { X: 4 },
      sections: { discovery: {}, ideas: {}, consensus: {}, risk: {}, orders: {}, marketData: {}, reconciliation: {}, javaBridge: {}, system: {} },
      coverageManifest: { sourceTable: 'fake', windowStartMs, windowEndMs, rowCount: 4, minTs: windowStartMs, maxTs: windowEndMs, eventTypesObserved: ['X'], eventTypesSummarized: [], unknownEventTypes: ['X'] },
    };
    const { computeChecksum } = await import('./checksum');
    // Manually insert a COMPACTED-but-never-VERIFIED row - simulates a process crash exactly
    // between the two steps.
    db.insert(schema.dailyLearningArchive).values({
      tradingDate: CLOSED_DATE, sourceType: 'T11', schemaVersion: 1, windowStartMs, windowEndMs,
      sourceRowCount: 4, summaryJson: JSON.stringify(summary), summaryChecksum: computeChecksum(summary),
      compactionStatus: 'COMPACTED', createdAt: nowMs,
    }).run();
    const outcome = orchestrator.verifyArchiveRow(source, CLOSED_DATE, nowMs);
    expect(outcome.status).toBe('VERIFIED'); // crash recovery resumes correctly, not stuck
  });

  it('crash between verify and purge: a VERIFIED-but-unpurged day is picked up correctly by a later purge sweep', async () => {
    const { source, rawRemaining } = makeFakeSource({ sourceType: 'T12', rowCount: 8 });
    await orchestrator.runDailyCompactionForDate(source, CLOSED_DATE, nowMs);
    const row = db.select().from(schema.dailyLearningArchive).all()[0];
    expect(row.compactionStatus).toBe('VERIFIED');
    expect(row.rawPurgedAt).toBeNull(); // simulates the crash point: verified, never purged
    const farFuture = nowMs + 400 * 24 * 60 * 60 * 1000;
    const result = orchestrator.purgeVerifiedDays(source, 14, farFuture);
    expect(result.purgedDays).toBe(1);
    expect(rawRemaining()).toBe(0);
  });

  it('partial purge: one failing day does not block other eligible days in the same sweep', async () => {
    const good1 = makeFakeSource({ sourceType: 'T13a', rowCount: 10 });
    const bad = makeFakeSource({ sourceType: 'T13b', rowCount: 10 });
    const good2 = makeFakeSource({ sourceType: 'T13c', rowCount: 10 });
    for (const { source } of [good1, bad, good2]) {
      await orchestrator.runDailyCompactionForDate(source, CLOSED_DATE, nowMs);
    }
    const throwingBad: DailyCompactionSource = { ...bad.source, purgeWindow: () => { throw new Error('boom'); } };
    const farFuture = nowMs + 400 * 24 * 60 * 60 * 1000;
    const r1 = orchestrator.purgeVerifiedDays(good1.source, 14, farFuture);
    const r2 = orchestrator.purgeVerifiedDays(throwingBad, 14, farFuture);
    const r3 = orchestrator.purgeVerifiedDays(good2.source, 14, farFuture);
    expect(r1.purgedDays).toBe(1);
    expect(r2.purgedDays).toBe(0); // bad day's own sweep call reports the failure
    expect(r3.purgedDays).toBe(1); // unaffected by the bad day
    expect(good1.rawRemaining()).toBe(0);
    expect(bad.rawRemaining()).toBe(10); // untouched
    expect(good2.rawRemaining()).toBe(0);
  });

  it('already-purged day is never re-purged or re-attempted', async () => {
    const { source, rawRemaining } = makeFakeSource({ sourceType: 'T14', rowCount: 6 });
    await orchestrator.runDailyCompactionForDate(source, CLOSED_DATE, nowMs);
    const farFuture = nowMs + 400 * 24 * 60 * 60 * 1000;
    const first = orchestrator.purgeVerifiedDays(source, 14, farFuture);
    const second = orchestrator.purgeVerifiedDays(source, 14, farFuture);
    expect(first.purgedDays).toBe(1);
    expect(second.purgedDays).toBe(0); // already PURGED - correctly excluded from "eligible"
    expect(rawRemaining()).toBe(0);
  });

  it('day newer than the retention cutoff is VERIFIED but correctly NOT purged yet', async () => {
    const { source, rawRemaining } = makeFakeSource({ sourceType: 'T15', rowCount: 9 });
    await orchestrator.runDailyCompactionForDate(source, CLOSED_DATE, nowMs);
    // nowMs is only 5 days after CLOSED_DATE - well inside a 14-day retention window.
    const result = orchestrator.purgeVerifiedDays(source, 14, nowMs);
    expect(result.purgedDays).toBe(0);
    expect(rawRemaining()).toBe(9); // raw data correctly retained
  });

  it('the current (not-yet-closed) trading day is never compacted, and therefore never purged', async () => {
    const { source, rawRemaining } = makeFakeSource({ sourceType: 'T16', rowCount: 3 });
    const today = tradingDayWindow.todayTradingDateStr(nowMs);
    const outcome = await orchestrator.runDailyCompactionForDate(source, today, nowMs);
    expect(outcome.status).toBe('PENDING');
    expect(outcome.reason).toBe('DAY_NOT_CLOSED');
    expect(db.select().from(schema.dailyLearningArchive).all()).toHaveLength(0);
    expect(rawRemaining()).toBe(3); // untouched - never even attempted
  });
});
