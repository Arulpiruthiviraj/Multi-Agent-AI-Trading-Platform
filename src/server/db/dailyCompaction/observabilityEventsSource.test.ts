import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getTradingDateWindowMs } from './tradingDayWindow';

/**
 * Real integration test against real observability_events rows (isolated temp DB, never
 * data/argus.db) - proves the actual compactor, not a fake stand-in.
 */
describe('observabilityEventsSource (real observability_events compaction)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let source: typeof import('./observabilityEventsSource').observabilityEventsSource;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_obs_events_compaction_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../index'));
    schema = await import('../schema');
    ({ observabilityEventsSource: source } = await import('./observabilityEventsSource'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
  });

  beforeEach(() => {
    db.delete(schema.observabilityEvents).run();
  });

  const TRADING_DATE = '2026-01-05';
  const { windowStartMs, windowEndMs } = getTradingDateWindowMs(TRADING_DATE);

  let seq = 0;
  function seedEvent(ts: number, eventType: string | null, category: string) {
    seq += 1;
    db.insert(schema.observabilityEvents).values({
      id: `ev-${seq}`, ts, level: 'INFO', category, eventType,
      loggerName: 'test', message: 'm', sessionId: 'sess-1',
    }).run();
  }

  it('compacts real seeded rows into exhaustive, exactly-reconciling counts', async () => {
    const mid = windowStartMs + 1000;
    seedEvent(mid, 'DISCOVERY_CANDIDATE_ADMITTED', 'DISCOVERY');
    seedEvent(mid, 'DISCOVERY_CANDIDATE_ADMITTED', 'DISCOVERY');
    seedEvent(mid, 'TRADE_IDEA_GENERATED', 'AGENT');
    seedEvent(mid, 'RISK_ASSESSMENT_COMPLETED', 'TRADING');
    seedEvent(mid, 'SOME_FUTURE_EVENT_TYPE', 'SYSTEM'); // deliberately unmapped
    // Outside the window - must NOT be counted.
    seedEvent(windowEndMs + 5000, 'DISCOVERY_CANDIDATE_ADMITTED', 'DISCOVERY');
    seedEvent(windowStartMs - 5000, 'DISCOVERY_CANDIDATE_ADMITTED', 'DISCOVERY');

    const { sourceRowCount, summary } = await source.compact(windowStartMs, windowEndMs, TRADING_DATE);

    expect(sourceRowCount).toBe(5);
    expect(summary.eventTypeCounts.DISCOVERY_CANDIDATE_ADMITTED).toBe(2);
    expect(summary.eventTypeCounts.TRADE_IDEA_GENERATED).toBe(1);
    expect(summary.sections.discovery.admitted).toBe(2);
    expect(summary.sections.ideas.generated).toBe(1);
    expect(summary.sections.risk.assessmentsCompleted).toBe(1);
    // Critical invariant (§8).
    const eventTypeSum = Object.values(summary.eventTypeCounts).reduce((a, b) => a + b, 0);
    expect(eventTypeSum).toBe(sourceRowCount);
    // Real, honest visibility into what the compactor does not yet name.
    expect(summary.coverageManifest.unknownEventTypes).toContain('SOME_FUTURE_EVENT_TYPE');
    expect(summary.coverageManifest.eventTypesSummarized).toContain('DISCOVERY_CANDIDATE_ADMITTED');
    expect(summary.coverageManifest.rowCount).toBe(5);
  });

  it('a day with zero real events compacts to a real, honest zero - not an error', async () => {
    const { sourceRowCount, summary } = await source.compact(windowStartMs, windowEndMs, TRADING_DATE);
    expect(sourceRowCount).toBe(0);
    expect(summary.coverageManifest.minTs).toBeNull();
    expect(summary.coverageManifest.maxTs).toBeNull();
    expect(Object.keys(summary.eventTypeCounts)).toHaveLength(0);
  });

  it('purgeWindow deletes only rows inside the window, leaving adjacent days untouched', async () => {
    const mid = windowStartMs + 1000;
    seedEvent(mid, 'DISCOVERY_CANDIDATE_ADMITTED', 'DISCOVERY');
    seedEvent(mid, 'DISCOVERY_CANDIDATE_ADMITTED', 'DISCOVERY');
    seedEvent(windowEndMs + 5000, 'DISCOVERY_CANDIDATE_ADMITTED', 'DISCOVERY'); // next day
    seedEvent(windowStartMs - 5000, 'DISCOVERY_CANDIDATE_ADMITTED', 'DISCOVERY'); // prior day

    const { deleted, truncated } = await source.purgeWindow(windowStartMs, windowEndMs);
    expect(deleted).toBe(2);
    expect(truncated).toBe(false);
    const remaining = db.select().from(schema.observabilityEvents).all();
    expect(remaining).toHaveLength(2); // the two adjacent-day rows survive
  });

  /**
   * 2026-10-08 I-E1 regression: purgeWindow was ONE single unbatched DELETE over the whole
   * window - a large window blocked the single-threaded event loop (the 2026-10-01 retention
   * postmortem measured 8+ minutes on a 9.8M-row backlog) in one synchronous slice. Now
   * batched + yielding: seed more rows than one config batch holds, and prove (a) all rows
   * are deleted, (b) the event loop got to run between batches (a setImmediate heartbeat ticks
   * while the purge is in flight), and (c) rows outside the window are untouched.
   */
  it('purgeWindow batches a large window and yields to the event loop between batches', async () => {
    const { observabilityConfig } = await import('../../config/observability');
    const batchSize = observabilityConfig.retentionSweepBatchSize; // real config, never a literal
    expect(batchSize).toBeGreaterThan(0);
    const mid = windowStartMs + 1000;
    const rowCount = batchSize * 2 + 1000; // forces 3 batches: full, full, partial
    // Fast bulk insert through the same single connection the source uses.
    const insertStmt = sqliteDb.prepare(
      `INSERT INTO observability_events (id, ts, level, category, event_type, logger_name, message, session_id)
       VALUES (?, ?, 'INFO', 'SYSTEM', 'RETENTION_TEST', 'test', 'm', 'sess-1')`
    );
    const insertMany = sqliteDb.transaction((n: number) => {
      for (let i = 0; i < n; i++) insertStmt.run(`purge-batch-${i}`, mid + i);
    });
    insertMany(rowCount);
    // Rows outside the window must survive the purge.
    seedEvent(windowEndMs + 5000, 'DISCOVERY_CANDIDATE_ADMITTED', 'DISCOVERY');

    let heartbeats = 0;
    let beating = true;
    const beat = () => {
      if (!beating) return;
      heartbeats++;
      setImmediate(beat);
    };
    setImmediate(beat);
    let result: { deleted: number; truncated: boolean };
    try {
      result = await source.purgeWindow(windowStartMs, windowEndMs);
    } finally {
      beating = false;
    }

    expect(result!.deleted).toBe(rowCount); // every eligible row deleted
    expect(result!.truncated).toBe(false); // 3 batches is far under the max-batches budget
    expect(heartbeats).toBeGreaterThan(0); // the loop yielded between batches - never one slice
    const remaining = db.select().from(schema.observabilityEvents).all();
    expect(remaining).toHaveLength(1); // only the adjacent-day row survives
    expect(remaining[0].ts).toBe(windowEndMs + 5000);
  });
});
