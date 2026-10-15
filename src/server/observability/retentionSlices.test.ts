/**
 * D9 regression (2026-10-15). Production evidence: the hourly retention sweep deleted 5,000 rows per statement; on the 31 GB database each statement blocked the trading event
 * loop for 1.7-2.6 s (five in a row at 19:03Z = a 5.9 s event-loop lag with trading enabled). Software-managed protective exits run on that loop. The fix is slice size and a
 * REAL pause between slices, deleting exactly the same rows. These tests pin: (1) the configured slice is small and paced, derived from the same config production loads;
 * (2) every expired row is still deleted and no fresh row is touched; (3) no single statement exceeds the slice; (4) a stop request halts the sweep between slices.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('retention deletes are small slices with a real pause (D9)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let store: typeof import('./ObservabilityStore');
  let obsCfg: any;
  let ri: any;
  let retention: typeof import('../db/operationalRetention');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_ret_slices_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb } = await import('../db'));
    ({ observabilityConfig: obsCfg } = await import('../config/observability'));
    ({ runtimeIntervals: ri } = await import('../config/runtimeIntervals'));
    store = await import('./ObservabilityStore');
    retention = await import('../db/operationalRetention');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) { try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ } }
  });

  beforeEach(async () => {
    await store.flushObservabilityStore();
    sqliteDb.prepare('DELETE FROM observability_events').run();
    sqliteDb.prepare('DELETE FROM consensus_evidence').run();
    sqliteDb.prepare('DELETE FROM consensus_decisions').run();
  });

  it('configured slices are small, paced, and still have capacity for production ingest (derived from the real config)', () => {
    expect(obsCfg.retentionSweepBatchSize).toBeLessThanOrEqual(500);            // ~0.4 ms/row on production => <= ~200 ms per statement
    expect(obsCfg.retentionSweepPauseMs).toBeGreaterThanOrEqual(100);          // a real pause, not a zero-delay yield
    expect(obsCfg.retentionSweepBatchSize * obsCfg.retentionSweepMaxBatchesPerCall).toBeGreaterThanOrEqual(110_000); // >= ~1 hour of production ingest per call
    expect(ri.consensusEvidenceSweepBatchSize).toBeLessThanOrEqual(500);
    expect(ri.consensusEvidenceSweepPauseMs).toBeGreaterThanOrEqual(100);
    expect(ri.consensusEvidenceSweepBatchSize * ri.consensusEvidenceSweepMaxBatchesPerCall).toBeGreaterThanOrEqual(50_000);
  });

  it('observability sweep deletes every expired row across several slices and never touches fresh rows; no statement exceeds the slice', async () => {
    const now = Date.now();
    const old = now - (obsCfg.retentionDays + 1) * 24 * 3600 * 1000;
    const batch = obsCfg.retentionSweepBatchSize;
    const expired = batch * 2 + 37;
    const ins = sqliteDb.prepare("INSERT INTO observability_events (id, ts, level, category, logger_name, message, session_id) VALUES (?, ?, 'INFO', 'SYSTEM', 'test', 'm', 's')");
    sqliteDb.transaction(() => { for (let i = 0; i < expired; i++) ins.run(`old-${i}`, old); for (let i = 0; i < 25; i++) ins.run(`new-${i}`, now); })();

    const seenChanges: number[] = [];
    const realPrepare = sqliteDb.prepare.bind(sqliteDb);
    (sqliteDb as any).prepare = (sql: string) => {
      const st = realPrepare(sql);
      if (/^DELETE FROM observability_events/i.test(sql)) { const run = st.run.bind(st); st.run = (...a: unknown[]) => { const r = run(...a); seenChanges.push(r.changes); return r; }; }
      return st;
    };
    const t0 = Date.now();
    let deleted: number;
    try { deleted = await store.sweepObservabilityRetention(now); } finally { (sqliteDb as any).prepare = realPrepare; }

    expect(deleted).toBe(expired);
    expect(sqliteDb.prepare('SELECT count(*) c FROM observability_events').get().c).toBe(25);
    expect(Math.max(...seenChanges)).toBeLessThanOrEqual(batch);
    expect(seenChanges.length).toBeGreaterThanOrEqual(3);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(obsCfg.retentionSweepPauseMs * 2 - 40); // paused between at least two pairs of slices
  });

  it('a stop request halts an in-flight observability sweep between slices', async () => {
    const now = Date.now();
    const old = now - (obsCfg.retentionDays + 1) * 24 * 3600 * 1000;
    const batch = obsCfg.retentionSweepBatchSize;
    const ins = sqliteDb.prepare("INSERT INTO observability_events (id, ts, level, category, logger_name, message, session_id) VALUES (?, ?, 'INFO', 'SYSTEM', 'test', 'm', 's')");
    sqliteDb.transaction(() => { for (let i = 0; i < batch * 4; i++) ins.run(`old-${i}`, old); })();
    const p = store.sweepObservabilityRetention(now); // first slice runs synchronously, then the sweep pauses
    setTimeout(() => store.stopObservabilityRetentionSweep(), Math.floor(obsCfg.retentionSweepPauseMs / 3));
    const deleted = await p;
    expect(deleted).toBe(batch);                                                    // exactly one slice, then it stopped
    expect(sqliteDb.prepare('SELECT count(*) c FROM observability_events').get().c).toBe(batch * 3);
  });

  it('consensus_evidence sweep removes only evidence of expired parents, in bounded slices', async () => {
    const now = Date.now();
    const oldIso = new Date(now - (ri.consensusEvidenceRetentionDays + 1) * 24 * 3600 * 1000).toISOString();
    const freshIso = new Date(now).toISOString();
    const batch = ri.consensusEvidenceSweepBatchSize;
    const dec = sqliteDb.prepare("INSERT INTO consensus_decisions (transaction_id, symbol, side, weighted_confidence, threshold, approved, agreements_count, disagreements_count, debate_used, created_at) VALUES (?, 'T', 'BUY', 0.5, 0.75, 0, 1, 0, 0, ?)");
    const ev = sqliteDb.prepare("INSERT INTO consensus_evidence (transaction_id, source_trace_id, agent, side, confidence, weight, agreed) VALUES (?, 'tr', 'A', 'BUY', 0.5, 1, 1)");
    sqliteDb.transaction(() => {
      dec.run('tx-old', oldIso); dec.run('tx-new', freshIso);
      for (let i = 0; i < batch * 2 + 11; i++) ev.run('tx-old');
      for (let i = 0; i < 9; i++) ev.run('tx-new');
    })();
    const deleted = await retention.sweepConsensusEvidenceRetention(now);
    expect(deleted).toBe(batch * 2 + 11);
    expect(sqliteDb.prepare("SELECT count(*) c FROM consensus_evidence WHERE transaction_id='tx-new'").get().c).toBe(9);
    expect(sqliteDb.prepare("SELECT count(*) c FROM consensus_evidence WHERE transaction_id='tx-old'").get().c).toBe(0);
  });
});
