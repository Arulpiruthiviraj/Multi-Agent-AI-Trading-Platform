import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Daily Learning Compaction Phase 1 (2026-10-01) - proves the one behavior change this phase makes
 * to the pre-existing sweepObservabilityRetention(): with dailyCompactionEnabled OFF (the real
 * default - not yet wired into live boot), behavior is BYTE-FOR-BYTE UNCHANGED from before this
 * phase (blind time-based delete). With it ON, raw rows are deleted ONLY via a VERIFIED archive
 * row - the mandate's own explicit safety rule.
 */
describe('sweepObservabilityRetention (Daily Learning Compaction Phase 1 gating)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let observabilityConfig: any;
  let store: typeof import('./ObservabilityStore');
  let orchestrator: typeof import('../db/dailyCompaction/DailyCompactionOrchestrator');
  let obsSource: typeof import('../db/dailyCompaction/observabilityEventsSource');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_obs_store_sweep_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ observabilityConfig } = await import('../config/observability'));
    store = await import('./ObservabilityStore');
    orchestrator = await import('../db/dailyCompaction/DailyCompactionOrchestrator');
    obsSource = await import('../db/dailyCompaction/observabilityEventsSource');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
  });

  let seq = 0;
  function seedEvent(ts: number) {
    seq += 1;
    db.insert(schema.observabilityEvents).values({
      id: `sweep-${seq}`, ts, level: 'INFO', category: 'SYSTEM',
      loggerName: 'test', message: 'm', sessionId: 'sess-1',
    }).run();
  }

  beforeEach(() => {
    db.delete(schema.observabilityEvents).run();
    db.delete(schema.dailyLearningArchive).run();
  });

  afterEach(() => {
    (observabilityConfig as any).dailyCompactionEnabled = false; // restore real default
    (observabilityConfig as any).retentionSweepBatchSize = 5000; // restore real default
    (observabilityConfig as any).retentionSweepMaxBatchesPerCall = 50; // restore real default
  });

  it('with dailyCompactionEnabled OFF (the real default), behavior is unchanged: a blind time-based delete regardless of archive state', async () => {
    const now = Date.now();
    const oldTs = now - (observabilityConfig.retentionDays + 1) * 24 * 60 * 60 * 1000;
    seedEvent(oldTs);
    seedEvent(now);
    expect(observabilityConfig.dailyCompactionEnabled).toBe(false);

    const deleted = await store.sweepObservabilityRetention(now);
    expect(deleted).toBe(1); // the old row, with NO archive row ever created - old blind-delete behavior
    expect(db.select().from(schema.observabilityEvents).all()).toHaveLength(1);
  });

  it('with dailyCompactionEnabled ON, an old day WITHOUT a VERIFIED archive row is correctly kept, not blind-deleted', async () => {
    (observabilityConfig as any).dailyCompactionEnabled = true;
    const now = Date.now();
    const oldTs = now - (observabilityConfig.retentionDays + 1) * 24 * 60 * 60 * 1000;
    seedEvent(oldTs);

    const deleted = await store.sweepObservabilityRetention(now);
    expect(deleted).toBe(0); // never compacted/verified - correctly retained despite being old
    expect(db.select().from(schema.observabilityEvents).all()).toHaveLength(1);
  });

  it('with dailyCompactionEnabled ON, an old day WITH a VERIFIED archive row is correctly purged', async () => {
    (observabilityConfig as any).dailyCompactionEnabled = true;
    const now = Date.now();
    const tradingDateMs = now - (observabilityConfig.retentionDays + 2) * 24 * 60 * 60 * 1000;
    const { getTradingDateStr } = await import('../core/TradingCalendar');
    const tradingDate = getTradingDateStr(new Date(tradingDateMs));
    const { getTradingDateWindowMs } = await import('../db/dailyCompaction/tradingDayWindow');
    const { windowStartMs } = getTradingDateWindowMs(tradingDate);
    seedEvent(windowStartMs + 1000);

    const outcome = await orchestrator.runDailyCompactionForDate(obsSource.observabilityEventsSource, tradingDate, now);
    expect(outcome.status).toBe('VERIFIED');

    const deleted = await store.sweepObservabilityRetention(now);
    expect(deleted).toBe(1);
    expect(db.select().from(schema.observabilityEvents).all()).toHaveLength(0);
  });

  it('2026-10-01 defect verification pass: a backlog larger than one batch is deleted across multiple bounded batches, never one unbatched delete', async () => {
    (observabilityConfig as any).retentionSweepBatchSize = 10;
    (observabilityConfig as any).retentionSweepMaxBatchesPerCall = 50;
    const now = Date.now();
    const oldTs = now - (observabilityConfig.retentionDays + 1) * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 37; i++) seedEvent(oldTs); // more than one 10-row batch, not a round multiple

    const deleted = await store.sweepObservabilityRetention(now);
    expect(deleted).toBe(37); // every expired row still gets deleted, just across several batches
    expect(db.select().from(schema.observabilityEvents).all()).toHaveLength(0);
  });

  it('2026-10-01 defect verification pass: a single sweep call never exceeds retentionSweepMaxBatchesPerCall * retentionSweepBatchSize rows, so a huge backlog cannot block the event loop in one call', async () => {
    (observabilityConfig as any).retentionSweepBatchSize = 10;
    (observabilityConfig as any).retentionSweepMaxBatchesPerCall = 3;
    const now = Date.now();
    const oldTs = now - (observabilityConfig.retentionDays + 1) * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 100; i++) seedEvent(oldTs); // far more than 3*10=30

    const deleted = await store.sweepObservabilityRetention(now);
    expect(deleted).toBe(30); // bounded to maxBatches * batchSize for this one call
    expect(db.select().from(schema.observabilityEvents).all()).toHaveLength(70); // the rest waits for the next sweep interval
  });
});
