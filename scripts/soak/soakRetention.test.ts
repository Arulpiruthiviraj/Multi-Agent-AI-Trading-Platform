/**
 * Soak retention + disk-full fail-fast regression tests (scripts/soak).
 *
 * Defect class, from the October chunked soak (seg1, 2026-10-13):
 *  - the synthetic DB grew ~8MB per successful iteration with no prune path, because
 *    production retention sweepers are time-based and synthetic timestamps sit inside
 *    every retention window;
 *  - when the disk filled, the child looped through 720,845 doomed iterations
 *    ("database or disk is full") instead of aborting.
 *
 * These tests prove: (1) old-iteration rows are pruned and recent rows kept, for both
 * ISO-text and epoch-ms timestamp columns; (2) the join-based consensus_evidence prune
 * follows parent age; (3) disk-full errors are detected across layers; (4) every
 * RETENTION_SWEEPERS table is either soak-pruned or explicitly excluded - the same
 * fail-by-design coverage guarantee as retentionCoverage.test.ts, so a future sweeper
 * cannot silently reintroduce unbounded soak growth.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  SOAK_PRUNE_TABLES,
  SOAK_PRUNE_EXCLUDED_TABLES,
  pruneSoakTable,
  pruneConsensusEvidenceSoak,
  pruneSoakIterations,
  isDiskFullError,
} from './soakRetention';

function makeTempDb(): { db: Database.Database; file: string } {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'soak-retention-test-')), 't.db');
  const db = new Database(file);
  return { db, file };
}

const OLD_ISO = new Date('2026-09-01T00:00:00.000Z').toISOString();
const NEW_ISO = new Date('2026-10-14T00:00:00.000Z').toISOString();
/** Keep window starts 2026-10-01: OLD rows are prunable, NEW rows are kept. */
const KEEP_FROM_MS = new Date('2026-10-01T00:00:00.000Z').getTime();
const OLD_EPOCH = new Date('2026-09-01T00:00:00.000Z').getTime();
const NEW_EPOCH = new Date('2026-10-14T00:00:00.000Z').getTime();

describe('soak retention (scripts/soak/soakRetention)', () => {
  describe('isDiskFullError', () => {
    it('detects better-sqlite3 SQLITE_FULL by code', () => {
      const e = Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
      expect(isDiskFullError(e)).toBe(true);
    });
    it('detects the sqlite message even without a code', () => {
      expect(isDiskFullError(new Error('database or disk is full'))).toBe(true);
    });
    it('detects OS-level ENOSPC', () => {
      const e = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      expect(isDiskFullError(e)).toBe(true);
      expect(isDiskFullError(new Error('no space left on device'))).toBe(true);
    });
    it('does not misfire on ordinary errors', () => {
      expect(isDiskFullError(new Error('SQLITE_CORRUPT: database disk image is malformed'))).toBe(false);
      expect(isDiskFullError(new Error('connection refused'))).toBe(false);
      expect(isDiskFullError(null)).toBe(false);
      expect(isDiskFullError(undefined)).toBe(false);
      expect(isDiskFullError('database or disk is full')).toBe(true); // string form still detected
    });
  });

  describe('pruneSoakTable', () => {
    it('prunes old ISO-timestamp rows, keeps recent ones', async () => {
      const { db } = makeTempDb();
      try {
        db.exec('CREATE TABLE t_iso (id INTEGER PRIMARY KEY, created_at TEXT)');
        db.prepare('INSERT INTO t_iso (created_at) VALUES (?)').run(OLD_ISO);
        db.prepare('INSERT INTO t_iso (created_at) VALUES (?)').run(OLD_ISO);
        db.prepare('INSERT INTO t_iso (created_at) VALUES (?)').run(NEW_ISO);
        const n = await pruneSoakTable({ table: 't_iso', column: 'created_at', kind: 'iso' }, KEEP_FROM_MS, db);
        expect(n).toBe(2);
        const remaining = db.prepare('SELECT created_at AS c FROM t_iso').all() as Array<{ c: string }>;
        expect(remaining.map((r) => r.c)).toEqual([NEW_ISO]);
      } finally {
        db.close();
      }
    });

    it('prunes old epoch-ms rows, keeps recent ones, honors a custom key column', async () => {
      const { db } = makeTempDb();
      try {
        db.exec('CREATE TABLE t_epoch (trace_id TEXT PRIMARY KEY, ts INTEGER)');
        db.prepare('INSERT INTO t_epoch (trace_id, ts) VALUES (?, ?)').run('old-1', OLD_EPOCH);
        db.prepare('INSERT INTO t_epoch (trace_id, ts) VALUES (?, ?)').run('new-1', NEW_EPOCH);
        const n = await pruneSoakTable(
          { table: 't_epoch', column: 'ts', kind: 'epochMs', keyColumn: 'trace_id' },
          KEEP_FROM_MS,
          db,
        );
        expect(n).toBe(1);
        const remaining = db.prepare('SELECT trace_id AS k FROM t_epoch').all() as Array<{ k: string }>;
        expect(remaining.map((r) => r.k)).toEqual(['new-1']);
      } finally {
        db.close();
      }
    });

    it('never throws on a missing table (one bad table must not kill the soak loop)', async () => {
      const { db } = makeTempDb();
      try {
        const n = await pruneSoakTable({ table: 'no_such_table', column: 'created_at', kind: 'iso' }, KEEP_FROM_MS, db);
        expect(n).toBe(0);
      } finally {
        db.close();
      }
    });
  });

  describe('pruneConsensusEvidenceSoak', () => {
    it('prunes evidence by parent decision age and removes orphans', async () => {
      const { db } = makeTempDb();
      try {
        db.exec('CREATE TABLE consensus_decisions (transaction_id TEXT PRIMARY KEY, created_at TEXT)');
        db.exec('CREATE TABLE consensus_evidence (id INTEGER PRIMARY KEY, transaction_id TEXT)');
        db.prepare('INSERT INTO consensus_decisions VALUES (?, ?)').run('tx-old', OLD_ISO);
        db.prepare('INSERT INTO consensus_decisions VALUES (?, ?)').run('tx-new', NEW_ISO);
        db.prepare('INSERT INTO consensus_evidence (transaction_id) VALUES (?)').run('tx-old');
        db.prepare('INSERT INTO consensus_evidence (transaction_id) VALUES (?)').run('tx-new');
        db.prepare('INSERT INTO consensus_evidence (transaction_id) VALUES (?)').run('tx-gone'); // orphan
        const n = await pruneConsensusEvidenceSoak(KEEP_FROM_MS, db);
        expect(n).toBe(2); // tx-old's evidence + the orphan
        const remaining = db.prepare('SELECT transaction_id AS t FROM consensus_evidence').all() as Array<{ t: string }>;
        expect(remaining.map((r) => r.t)).toEqual(['tx-new']);
      } finally {
        db.close();
      }
    });
  });

  describe('pruneSoakIterations', () => {
    it('prunes every configured table in one pass', async () => {
      const { db } = makeTempDb();
      try {
        // Build a miniature of the real table set: one iso table, one epoch table.
        db.exec('CREATE TABLE agent_predictions (id INTEGER PRIMARY KEY, timestamp TEXT)');
        db.exec('CREATE TABLE ohlcv_bars (id TEXT PRIMARY KEY, timestamp INTEGER)');
        db.prepare('INSERT INTO agent_predictions (timestamp) VALUES (?)').run(OLD_ISO);
        db.prepare('INSERT INTO agent_predictions (timestamp) VALUES (?)').run(NEW_ISO);
        db.prepare('INSERT INTO ohlcv_bars (id, timestamp) VALUES (?, ?)').run('b-old', OLD_EPOCH);
        db.prepare('INSERT INTO ohlcv_bars (id, timestamp) VALUES (?, ?)').run('b-new', NEW_EPOCH);
        const { totalDeleted, deletedByTable } = await pruneSoakIterations(KEEP_FROM_MS, db);
        // Only tables present in this miniature DB delete rows; missing tables are skipped silently.
        expect(deletedByTable['agent_predictions']).toBe(1);
        expect(deletedByTable['ohlcv_bars']).toBe(1);
        expect(totalDeleted).toBe(2);
        expect(
          (db.prepare('SELECT COUNT(*) AS c FROM agent_predictions').get() as { c: number }).c,
        ).toBe(1);
        expect((db.prepare('SELECT COUNT(*) AS c FROM ohlcv_bars').get() as { c: number }).c).toBe(1);
      } finally {
        db.close();
      }
    });
  });

  describe('registry coverage (fail by design)', () => {
    let registryTables: string[];
    beforeAll(async () => {
      // Imported dynamically like retentionCoverage.test.ts - we only read the registry,
      // never run a sweeper, so no production data is touched.
      const mod = await import('../../src/server/db/operationalRetention');
      registryTables = mod.RETENTION_SWEEPERS.map((s: { table: string }) => s.table);
    });

    it('every RETENTION_SWEEPERS table is soak-pruned or explicitly excluded', () => {
      const covered = new Set([
        ...SOAK_PRUNE_TABLES.map((t) => t.table),
        'consensus_evidence', // join-based prune, handled by pruneConsensusEvidenceSoak
        ...SOAK_PRUNE_EXCLUDED_TABLES,
      ]);
      const missing = registryTables.filter((t) => !covered.has(t));
      expect(
        missing,
        `RETENTION_SWEEPERS tables with no soak prune story (unbounded soak growth): ${JSON.stringify(missing)}`,
      ).toEqual([]);
    });

    it('soak prune list and exclusion list do not overlap', () => {
      const pruned = new Set(SOAK_PRUNE_TABLES.map((t) => t.table));
      for (const t of SOAK_PRUNE_EXCLUDED_TABLES) {
        expect(pruned.has(t), `${t} is both pruned and excluded`).toBe(false);
      }
      expect(new Set(SOAK_PRUNE_TABLES.map((t) => t.table)).size).toBe(SOAK_PRUNE_TABLES.length);
    });
  });
});
