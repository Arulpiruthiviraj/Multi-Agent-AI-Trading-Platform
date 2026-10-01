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
// @ts-nocheck

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
    void this.backupGuard.run(async () => { await this.runBackup(); });
    this.intervalId = setInterval(() => { void this.backupGuard.run(async () => { await this.runBackup(); }); }, INTERVAL_MS);
    console.log("[DbBackupService] Daily DB backup scheduled.");
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

      await this.pruneOldBackups();
      return dest;
    } catch (e) {
      await fs.unlink(temporary).catch(() => {});
      console.error("[DbBackupService] Backup failed:", e);
      throw e;
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
