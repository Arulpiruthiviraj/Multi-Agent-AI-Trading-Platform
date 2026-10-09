/**
 * Retention tests for decision_provenance (2026-10-09, certification mission item 1).
 * Per-Quant-decision PIT replay provenance must not grow unbounded. Proves, following the
 * existing newsRetention.test.ts / sessionGuardRetention.test.ts pattern:
 *  - old rows are pruned, recent rows are kept (cutoff = decisionProvenanceRetentionDays)
 *  - the sweep is idempotent (second run deletes nothing)
 *  - a large backlog does NOT block the event loop (batched + yielding: a heartbeat
 *    scheduled with setImmediate must tick while the sweep works through multiple batches)
 *  - the sweeper never throws (returns a partial count on error)
 *
 * Isolation: ARGUS_DB_PATH points at a temp SQLite file; migrations run on import.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('decision_provenance retention sweep', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let sweepDecisionProvenanceRetention: (nowMs?: number) => Promise<number>;
  let intervals: any;

  const daysAgoIso = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const uid = () => `ret-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_pitretention_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ sqliteDb } = await import('../../db/index'));
    ({ sweepDecisionProvenanceRetention } = await import('./decisionProvenance'));
    ({ runtimeIntervals: intervals } = await import('../../config/runtimeIntervals'));
  });

  afterAll(() => {
    try { fs.unlinkSync(tmpDbPath); } catch { /* best effort */ }
    delete process.env.ARGUS_DB_PATH;
  });

  function insertRow(id: string, createdAtIso: string) {
    sqliteDb.prepare(
      `INSERT INTO decision_provenance (id, decision_id, symbol, timeframe, decision_time_ms, created_at)
       VALUES (?, ?, 'TST', '1Day', ?, ?)`,
    ).run(id, id, Date.now(), createdAtIso);
  }

  it('prunes rows older than retention and keeps recent ones', async () => {
    const oldId = uid();
    const newId = uid();
    insertRow(oldId, daysAgoIso(intervals.decisionProvenanceRetentionDays + 5));
    insertRow(newId, daysAgoIso(1));

    const deleted = await sweepDecisionProvenanceRetention();

    expect(deleted).toBe(1);
    expect(sqliteDb.prepare('SELECT id FROM decision_provenance WHERE id = ?').get(oldId)).toBeUndefined();
    expect(sqliteDb.prepare('SELECT id FROM decision_provenance WHERE id = ?').get(newId)).toBeDefined();
  });

  it('is idempotent: a second sweep deletes nothing', async () => {
    const id = uid();
    insertRow(id, daysAgoIso(intervals.decisionProvenanceRetentionDays + 1));
    expect(await sweepDecisionProvenanceRetention()).toBe(1);
    expect(await sweepDecisionProvenanceRetention()).toBe(0);
  });

  it('does not block the event loop while working through multiple batches', async () => {
    const batchSize: number = intervals.newsRetentionSweepBatchSize;
    const total = batchSize + 500;
    const oldIso = daysAgoIso(intervals.decisionProvenanceRetentionDays + 1);
    const insert = sqliteDb.prepare(
      `INSERT INTO decision_provenance (id, decision_id, symbol, timeframe, decision_time_ms, created_at)
       VALUES (?, ?, 'TST', '1Day', ?, ?)`,
    );
    const prefix = uid();
    const txn = sqliteDb.transaction((n: number) => {
      for (let i = 0; i < n; i++) insert.run(`${prefix}-${i}`, `${prefix}-${i}`, Date.now(), oldIso);
    });
    txn(total);

    let heartbeats = 0;
    let keepBeating = true;
    const beat = () => {
      if (!keepBeating) return;
      heartbeats++;
      setImmediate(beat);
    };
    setImmediate(beat);

    const deleted = await sweepDecisionProvenanceRetention();
    keepBeating = false;

    expect(deleted).toBe(total);
    expect(heartbeats).toBeGreaterThan(0);
    expect(
      sqliteDb.prepare(`SELECT COUNT(*) AS n FROM decision_provenance WHERE id LIKE ?`).get(`${prefix}-%`).n,
    ).toBe(0);
  });

  it('never throws when the table is missing (returns a partial count)', async () => {
    sqliteDb.exec('ALTER TABLE decision_provenance RENAME TO decision_provenance_bak');
    try {
      const deleted = await sweepDecisionProvenanceRetention();
      expect(deleted).toBe(0);
    } finally {
      sqliteDb.exec('ALTER TABLE decision_provenance_bak RENAME TO decision_provenance');
    }
    // The table is back and the sweeper works again.
    const id = uid();
    insertRow(id, daysAgoIso(intervals.decisionProvenanceRetentionDays + 1));
    expect(await sweepDecisionProvenanceRetention()).toBe(1);
  });
});
