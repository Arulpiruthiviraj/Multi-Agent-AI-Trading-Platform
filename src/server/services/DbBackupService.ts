/**
 * ==========================================================
 * Module: DbBackupService.ts
 *
 * Purpose:
 * Daily snapshot of data/argus.db so a corrupted or deleted
 * database file doesn't mean losing all trade/portfolio history.
 * ==========================================================
 */
import fs from 'fs';
import path from 'path';
import { dbPath, sqliteDb } from '../db';
import { runtimeIntervals } from '../config/runtimeIntervals';

const BACKUP_DIR = path.join(path.dirname(dbPath), 'backups');
const INTERVAL_MS = runtimeIntervals.dbBackupIntervalMs;
const RETENTION_DAYS = runtimeIntervals.dbBackupRetentionDays;

export class DbBackupService {
  private intervalId: NodeJS.Timeout | null = null;

  start() {
    if (this.intervalId) return;
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    this.runBackup();
    this.intervalId = setInterval(() => this.runBackup(), INTERVAL_MS);
    console.log("[DbBackupService] Daily DB backup scheduled.");
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  runBackup() {
    try {
      if (!fs.existsSync(dbPath)) {
        console.warn("[DbBackupService] No database file to back up yet.");
        return;
      }
      // Recent commits in WAL mode can live only in the -wal file; checkpoint first so a
      // straight file copy doesn't silently miss them (same approach as /system/export-db).
      sqliteDb.pragma('wal_checkpoint(TRUNCATE)');

      const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const dest = path.join(BACKUP_DIR, `argus_${stamp}.db`);
      fs.copyFileSync(dbPath, dest);
      console.log(`[DbBackupService] Backed up database to ${dest}`);

      this.pruneOldBackups();
    } catch (e) {
      console.error("[DbBackupService] Backup failed:", e);
    }
  }

  private pruneOldBackups() {
    try {
      const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
      for (const file of fs.readdirSync(BACKUP_DIR)) {
        if (!file.startsWith('argus_') || !file.endsWith('.db')) continue;
        const full = path.join(BACKUP_DIR, file);
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.unlinkSync(full);
          console.log(`[DbBackupService] Pruned old backup ${file}`);
        }
      }
    } catch (e) {
      console.error("[DbBackupService] Prune failed:", e);
    }
  }
}

export const dbBackupService = new DbBackupService();
