/**
 * ==========================================================
 * Module: DbBackupService.ts
 *
 * Purpose:
 * Daily snapshot of data/argus.db so a corrupted or deleted
 * database file doesn't mean losing all trade/portfolio history.
 *
 * Event-loop-safety fix (2026-09-14 overnight remediation, mandate section 4 - synchronous
 * event-loop blocker audit): this ran a full `fs.copyFileSync()` of the live database file on
 * EVERY engine boot (start() calls runBackup() immediately, not just on the 24h interval), and
 * the real file was measured at 4.08GB during this same audit. Unlike v8.writeHeapSnapshot() (the
 * P1-B incident cause, which has no async alternative - V8's heap walk is inherently synchronous),
 * Node's fs.copyFile has a genuine, real async form: file I/O is offloaded to libuv's threadpool,
 * not run synchronously on the main JS thread, so this conversion is a real fix, not a fake
 * non-blocking wrapper around a still-blocking call (that distinction matters - see
 * heapSnapshotCapture.ts's own header for why the same trick does NOT work there).
 *
 * sqliteDb.pragma('wal_checkpoint(TRUNCATE)') remains genuinely synchronous - better-sqlite3 has
 * no async API by design - and is a real, smaller, harder-to-eliminate residual risk, honestly
 * left as-is here (not silently ignored): a WAL checkpoint's cost scales with uncommitted WAL
 * data, typically much smaller than the full DB file for a system that checkpoints periodically,
 * but not zero. Out of scope to redesign tonight (would mean changing the SQLite driver).
 * ==========================================================
 */
import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { dbPath, sqliteDb } from '../db';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { createSingleFlightGuard } from '../core/singleFlightInterval';

const BACKUP_DIR = path.join(path.dirname(dbPath), 'backups');
const INTERVAL_MS = runtimeIntervals.dbBackupIntervalMs;
const RETENTION_DAYS = runtimeIntervals.dbBackupRetentionDays;

export class DbBackupService {
  private intervalId: NodeJS.Timeout | null = null;
  // Batch 2 timer/reentrancy sweep (2026-09-23): runBackup() does a real fs.copyFile of a file
  // measured at 4.08GB (see this module's own header) plus a synchronous WAL checkpoint. INTERVAL_MS
  // is daily so a real overlap is unlikely, but start() also fires an immediate runBackup() before
  // arming the timer, and any future manual "backup now" trigger would race it - single-flight is a
  // pure addition here (coalesce, never queue), same contract as every other guard in this pass.
  private backupGuard = createSingleFlightGuard((e) => console.error('[DbBackupService] Backup cycle failed', e));

  start() {
    if (this.intervalId) return;
    if (!existsSync(BACKUP_DIR)) {
      // mkdir itself is cheap/near-instant (creating one directory) - not the same risk class as
      // copying a multi-GB file; left synchronous for startup-ordering simplicity.
      mkdirSync(BACKUP_DIR, { recursive: true });
    }
    void this.backupGuard.run(() => this.runBackup());
    this.intervalId = setInterval(() => { void this.backupGuard.run(() => this.runBackup()); }, INTERVAL_MS);
    console.log("[DbBackupService] Daily DB backup scheduled.");
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async runBackup(): Promise<void> {
    try {
      if (!existsSync(dbPath)) {
        console.warn("[DbBackupService] No database file to back up yet.");
        return;
      }
      // Recent commits in WAL mode can live only in the -wal file; checkpoint first so a
      // straight file copy doesn't silently miss them (same approach as /system/export-db).
      // Genuinely synchronous (better-sqlite3 has no async API) - see this module's own header.
      sqliteDb.pragma('wal_checkpoint(TRUNCATE)');

      const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const dest = path.join(BACKUP_DIR, `argus_${stamp}.db`);
      await fs.copyFile(dbPath, dest); // async - libuv threadpool, does not block the event loop
      console.log(`[DbBackupService] Backed up database to ${dest}`);

      await this.pruneOldBackups();
    } catch (e) {
      console.error("[DbBackupService] Backup failed:", e);
    }
  }

  private async pruneOldBackups(): Promise<void> {
    try {
      const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
      const files = await fs.readdir(BACKUP_DIR);
      for (const file of files) {
        if (!file.startsWith('argus_') || !file.endsWith('.db')) continue;
        const full = path.join(BACKUP_DIR, file);
        const st = await fs.stat(full);
        if (st.mtimeMs < cutoff) {
          await fs.unlink(full);
          console.log(`[DbBackupService] Pruned old backup ${file}`);
        }
      }
    } catch (e) {
      console.error("[DbBackupService] Prune failed:", e);
    }
  }
}

export const dbBackupService = new DbBackupService();
