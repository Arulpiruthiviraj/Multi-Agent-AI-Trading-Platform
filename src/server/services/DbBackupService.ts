/**
 * ==========================================================
 * Module: DbBackupService.ts
 *
 * Purpose:
 * Daily snapshot of data/argus.db so a corrupted or deleted
 * database file doesn't mean losing all trade/portfolio history.
 *
 * Uses SQLite's online backup API, including committed WAL data. A unique temporary file is
 * integrity-checked before atomic publication. Failed snapshots never replace earlier backups.
 * The destination integrity check remains synchronous; large-database latency is unmeasured.
 * ==========================================================
 */
import fs from 'fs/promises';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { dbPath, sqliteDb } from '../db';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { createSingleFlightGuard } from '../core/singleFlightInterval';

const BACKUP_DIR = path.join(path.dirname(dbPath), 'backups');
const INTERVAL_MS = runtimeIntervals.dbBackupIntervalMs;
const RETENTION_DAYS = runtimeIntervals.dbBackupRetentionDays;
const MAX_COUNT = runtimeIntervals.dbBackupMaxCount;
const ORPHAN_CLEANUP_AGE_MS = runtimeIntervals.dbBackupOrphanCleanupAgeMs;
const MIN_FREE_SPACE_MULTIPLIER = runtimeIntervals.dbBackupMinFreeSpaceMultiplier;

/** A completed, published backup - the only kind pruning by age/count should ever consider. */
function isPublishedBackupName(file: string): boolean {
  return file.startsWith('argus_') && file.endsWith('.db');
}

/** Anything left behind by an interrupted copy (crash/restart mid-backup) - never has restore
 *  value once abandoned, regardless of the 30-day/max-count retention rules below. */
function isOrphanArtifactName(file: string): boolean {
  return /\.partial(-wal|-shm|-journal)?$/.test(file);
}

export class DbBackupService {
  private intervalId: NodeJS.Timeout | null = null;
  // Coalesce scheduled snapshots. Direct callers receive a unique destination or a rejection.
  private backupGuard = createSingleFlightGuard((e) => console.error('[DbBackupService] Backup cycle failed', e));

  start() {
    if (this.intervalId) return;
    if (!existsSync(BACKUP_DIR)) {
      // mkdir itself is cheap/near-instant (creating one directory) - not the same risk class as
      // copying a multi-GB file; left synchronous for startup-ordering simplicity.
      mkdirSync(BACKUP_DIR, { recursive: true });
    }
    // 2026-10-07 defect fix: start() previously ran an unconditional immediate backup on every
    // call, independent of INTERVAL_MS - confirmed live, 5 process restarts in one day produced 5
    // immediate multi-GB backup attempts clustered within hours, far more often than the intended
    // daily cadence. Skip the immediate run if a published backup already exists younger than the
    // interval; the setInterval timer below still fires on schedule either way.
    void this.maybeRunInitialBackup();
    this.intervalId = setInterval(() => { void this.backupGuard.run(async () => { await this.runBackup(); }); }, INTERVAL_MS);
    console.log("[DbBackupService] Daily DB backup scheduled.");
  }

  private async maybeRunInitialBackup(): Promise<void> {
    try {
      const files = await fs.readdir(BACKUP_DIR);
      let newestMs = 0;
      for (const file of files) {
        if (!isPublishedBackupName(file)) continue;
        const st = await fs.stat(path.join(BACKUP_DIR, file));
        if (st.mtimeMs > newestMs) newestMs = st.mtimeMs;
      }
      if (newestMs > 0 && Date.now() - newestMs < INTERVAL_MS) {
        console.log(`[DbBackupService] Skipping startup backup - newest existing backup is ${Math.round((Date.now() - newestMs) / 60000)}min old, under the ${Math.round(INTERVAL_MS / 60000)}min interval.`);
        return;
      }
    } catch (e) {
      console.error('[DbBackupService] Failed to check existing backups before startup run - proceeding with a backup attempt anyway', e);
    }
    await this.backupGuard.run(async () => { await this.runBackup(); });
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async runBackup(): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `argus_${stamp}_${randomUUID()}.db`);
    const temporary = `${dest}.partial`;
    try {
      if (!existsSync(dbPath)) {
        throw new Error('No database file to back up');
      }
      await fs.mkdir(BACKUP_DIR, { recursive: true });

      // 2026-10-07 defect fix: previously nothing checked free disk space before starting a
      // multi-GB copy - confirmed live, the disk ran to exactly 0 bytes free partway through a
      // backup attempt. Refuse up front (same failure/catch path as any other backup error, so
      // pruning below still runs) rather than starting a copy that cannot finish.
      const dbStat = await fs.stat(dbPath);
      const free = await this.getFreeDiskSpaceBytes(path.dirname(dbPath));
      if (free !== null && free < dbStat.size * MIN_FREE_SPACE_MULTIPLIER) {
        throw new Error(
          `Refusing backup: ${Math.round(free / 1e9)}GB free is below the required ` +
          `${MIN_FREE_SPACE_MULTIPLIER}x of the live DB's ${Math.round(dbStat.size / 1e9)}GB size.`
        );
      }

      // SQLite's online backup API includes WAL contents and owns snapshot consistency.
      await sqliteDb.backup(temporary);
      const verify = new Database(temporary, { readonly: true, fileMustExist: true });
      try {
        const rows = verify.pragma('integrity_check') as Array<{ integrity_check: string }>;
        if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw new Error('Backup integrity check failed');
      } finally {
        verify.close();
      }
      await fs.rename(temporary, dest);
      console.log(`[DbBackupService] Backed up database to ${dest}`);
      return dest;
    } catch (e) {
      await fs.unlink(temporary).catch(() => {});
      console.error("[DbBackupService] Backup failed:", e);
      throw e;
    } finally {
      // 2026-10-07 defect fix: previously only ran after a successful backup, so a run of failed
      // days never pruned anything, including orphaned .partial files left by earlier crashes -
      // confirmed live, 62GB of such orphans had accumulated with zero owner left to clean them.
      // Always runs, success or failure, and never throws past this method.
      await this.pruneOldBackups();
    }
  }

  /** Returns null (skip the check) rather than throwing if the platform/filesystem can't report
   *  free space - a missing disk-space signal should not itself block backups. */
  private async getFreeDiskSpaceBytes(dir: string): Promise<number | null> {
    try {
      const anyFs = fs as unknown as { statfs?: (p: string) => Promise<{ bavail: number; bsize: number }> };
      if (typeof anyFs.statfs !== 'function') return null;
      const stats = await anyFs.statfs(dir);
      return stats.bavail * stats.bsize;
    } catch {
      return null;
    }
  }

  private async pruneOldBackups(): Promise<void> {
    try {
      const files = await fs.readdir(BACKUP_DIR);

      // Orphaned .partial/.partial-wal/.partial-shm/.partial-journal files from an interrupted
      // copy have zero restore value at any age - but a short grace period avoids racing a backup
      // that is genuinely still in progress (this method also runs in this same process's own
      // finally block, after that copy has already finished or failed, so this is a second-order
      // safety net for a concurrent/other-process orphan, not the common case).
      for (const file of files) {
        if (!isOrphanArtifactName(file)) continue;
        const full = path.join(BACKUP_DIR, file);
        try {
          const st = await fs.stat(full);
          if (Date.now() - st.mtimeMs >= ORPHAN_CLEANUP_AGE_MS) {
            await fs.unlink(full);
            console.log(`[DbBackupService] Swept orphaned backup artifact ${file}`);
          }
        } catch { /* file may have been cleaned up concurrently - not an error */ }
      }

      // Published backups: prune by whichever of (age, count) is more restrictive. Day-based
      // retention alone is unsustainable once the DB is multi-GB (30 days x ~13GB observed would
      // be ~390GB) - the count cap is what actually bounds disk usage in practice.
      const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
      const published: { file: string; mtimeMs: number }[] = [];
      for (const file of files) {
        if (!isPublishedBackupName(file)) continue;
        const st = await fs.stat(path.join(BACKUP_DIR, file));
        published.push({ file, mtimeMs: st.mtimeMs });
      }
      published.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

      for (let i = 0; i < published.length; i++) {
        const { file, mtimeMs } = published[i];
        const beyondCount = i >= MAX_COUNT;
        const beyondAge = mtimeMs < cutoff;
        if (beyondCount || beyondAge) {
          await fs.unlink(path.join(BACKUP_DIR, file));
          console.log(`[DbBackupService] Pruned old backup ${file} (${beyondCount ? 'count cap' : 'age cutoff'})`);
        }
      }
    } catch (e) {
      console.error("[DbBackupService] Prune failed:", e);
    }
  }
}

export const dbBackupService = new DbBackupService();
