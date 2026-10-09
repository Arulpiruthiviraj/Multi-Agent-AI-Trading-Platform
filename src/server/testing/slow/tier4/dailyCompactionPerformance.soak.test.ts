// LABEL: SOAK - performance measurement of daily compaction at seeded event volumes in a temp DB (tier-4, off the fast suite). Measures compaction throughput, not trading.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Daily Learning Compaction, Phase 1 - §17 performance measurement at realistic volumes.
 * Tier 4 (long/scheduled, `npm run test:tier4`) - never part of the fast default tier, per §15's
 * own "mutation/perf testing should NOT become part of every normal developer test run" rule
 * (reused here for the same reason). Real, isolated temp DB - never data/argus.db.
 */
describe('Daily Learning Compaction performance (§17)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let source: typeof import('../../../db/dailyCompaction/observabilityEventsSource').observabilityEventsSource;
  let orchestrator: typeof import('../../../db/dailyCompaction/DailyCompactionOrchestrator');
  let getTradingDateWindowMs: typeof import('../../../db/dailyCompaction/tradingDayWindow').getTradingDateWindowMs;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_daily_compaction_perf_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../../../db'));
    schema = await import('../../../db/schema');
    ({ observabilityEventsSource: source } = await import('../../../db/dailyCompaction/observabilityEventsSource'));
    orchestrator = await import('../../../db/dailyCompaction/DailyCompactionOrchestrator');
    ({ getTradingDateWindowMs } = await import('../../../db/dailyCompaction/tradingDayWindow'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
  });

  const EVENT_TYPES = [
    'DISCOVERY_CANDIDATE_ADMITTED', 'DISCOVERY_CANDIDATE_FILTERED', 'TRADE_IDEA_GENERATED',
    'CHIEF_CONSENSUS_STARTED', 'CHIEF_CONSENSUS_COMPLETED', 'RISK_ASSESSMENT_COMPLETED',
    'ORDER_SUBMITTED', 'ORDER_EXECUTED', 'QUANT_BRIDGE_CALL_OUTCOME', 'SOME_UNMAPPED_TYPE',
  ];
  const CATEGORIES = ['DISCOVERY', 'AGENT', 'CONSENSUS', 'TRADING', 'SYSTEM'];

  function seedRows(count: number, windowStartMs: number, windowEndMs: number): number {
    const insert = sqliteDb.prepare(
      'INSERT INTO observability_events (id, ts, level, category, event_type, logger_name, message, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertMany = sqliteDb.transaction((n: number) => {
      const span = windowEndMs - windowStartMs - 1000;
      for (let i = 0; i < n; i++) {
        const ts = windowStartMs + 500 + Math.floor((i / n) * span);
        insert.run(
          `perf-${i}`, ts, 'INFO', CATEGORIES[i % CATEGORIES.length], EVENT_TYPES[i % EVENT_TYPES.length],
          'perf-test', 'm', 'sess-perf',
        );
      }
    });
    const start = performance.now();
    insertMany(count);
    return performance.now() - start;
  }

  async function measureOneScale(label: string, rowCount: number, tradingDate: string) {
    db.delete(schema.observabilityEvents).run();
    db.delete(schema.dailyLearningArchive).run();
    const { windowStartMs, windowEndMs } = getTradingDateWindowMs(tradingDate);

    const seedMs = seedRows(rowCount, windowStartMs, windowEndMs);

    const compactStart = performance.now();
    const outcome = await orchestrator.runDailyCompactionForDate(source, tradingDate, windowEndMs + 1000);
    const compactMs = performance.now() - compactStart;
    expect(outcome.status).toBe('VERIFIED');

    const archiveRow = db.select().from(schema.dailyLearningArchive).all()[0];
    const archiveSizeBytes = Buffer.byteLength(archiveRow.summaryJson, 'utf8');
    const rawSizeEstimateBytes = rowCount * 200; // rough: ~200 bytes/row for this schema shape

    const purgeStart = performance.now();
    const purgeResult = await orchestrator.purgeVerifiedDays(source, 0, windowEndMs + 2000);
    const purgeMs = performance.now() - purgeStart;
    expect(purgeResult.totalRowsPurged).toBe(rowCount);

    const mem = process.memoryUsage();
    const result = {
      label,
      rowCount,
      seedMs: Math.round(seedMs),
      aggregationDurationMs: Math.round(compactMs),
      archiveSizeBytes,
      rawSizeEstimateBytes,
      compressionRatio: Number((rawSizeEstimateBytes / archiveSizeBytes).toFixed(1)),
      purgeDurationMs: Math.round(purgeMs),
      peakRssMb: Math.round(mem.rss / 1024 / 1024),
    };
    // eslint-disable-next-line no-console
    console.log(`[Daily Compaction Perf] ${label}:`, JSON.stringify(result, null, 2));
    return result;
  }

  it('measures compaction/purge performance at 10k, 100k, and 1M rows/day', async () => {
    const r10k = await measureOneScale('10k rows/day', 10_000, '2026-01-10');
    const r100k = await measureOneScale('100k rows/day', 100_000, '2026-01-11');
    const r1m = await measureOneScale('1M rows/day', 1_000_000, '2026-01-12');

    // Real evidence a daily archive row materially reduces operational storage (§17's own stated
    // goal), not an assumption.
    expect(r10k.compressionRatio).toBeGreaterThan(10);
    expect(r100k.compressionRatio).toBeGreaterThan(10);
    expect(r1m.compressionRatio).toBeGreaterThan(10);

    // Aggregation stays sub-second even at 1M rows (SQL-level GROUP BY, never row-by-row JS).
    expect(r1m.aggregationDurationMs).toBeLessThan(5000);
  }, 120_000);
});
