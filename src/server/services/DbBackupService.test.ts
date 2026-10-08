import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

const isPublishedName = (f: string) => f.startsWith('argus_') && f.endsWith('.db');

/**
 * Real end-to-end backup/restore drill (Phase 23): BACKUP -> ISOLATE/LOSE THE "LIVE" FILE ->
 * RESTORE -> VERIFY DATA, against real files on disk (not mocks). This exists because Section 15's
 * data-safety incident found real, scheduled backup code with no verified-working on-disk backup
 * at audit time - this test makes that verification automated and repeatable instead of a one-off
 * manual drill.
 *
 * Uses an isolated temp directory throughout - never the real data/argus.db or data/backups/.
 */
describe('DbBackupService - real backup/restore drill (Phase 23)', () => {
  let tmpRoot: string;
  let liveDbPath: string;
  let backupDir: string;
  let DbBackupService: any;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'argus_backupdrill_'));
    liveDbPath = path.join(tmpRoot, 'argus.db');
    backupDir = path.join(tmpRoot, 'backups');

    // DbBackupService derives BACKUP_DIR and reads dbPath/sqliteDb from '../db' at import time,
    // so point ARGUS_DB_PATH at our isolated file before importing either module.
    process.env.ARGUS_DB_PATH = liveDbPath;
    ({ DbBackupService } = await import('./DbBackupService'));

    // start() normally creates this directory before ever calling runBackup() - calling
    // runBackup() directly in these tests (to avoid start()'s eternal setInterval) means doing
    // the same real precondition here instead.
    fs.mkdirSync(backupDir, { recursive: true });
  });

  afterAll(() => {
    delete process.env.ARGUS_DB_PATH;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  });

  // Runs BEFORE the destructive drill below, which permanently closes the shared sqliteDb
  // connection to accurately simulate the file becoming inaccessible (see that test's comment).
  it('prunes backups older than the retention window, keeps recent ones', async () => {
    const service = new DbBackupService();
    const oldFile = path.join(backupDir, 'argus_2020-01-01.db');
    fs.writeFileSync(oldFile, 'irrelevant content - only mtime matters for pruning');
    const oldTime = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40 days ago, beyond the 30-day retention window
    fs.utimesSync(oldFile, oldTime / 1000, oldTime / 1000);

    // Event-loop-safety fix (2026-09-14): runBackup() is now async (real fs.promises I/O,
    // no longer a synchronous multi-GB blocking copy on the live process) - must be awaited.
    const backupFile = await service.runBackup(); // verified snapshot

    expect(fs.existsSync(oldFile)).toBe(false); // pruned
    const stamp = new Date().toISOString().slice(0, 10);
    expect(fs.existsSync(backupFile)).toBe(true); // today's backup kept
  });

  it('sweeps orphaned .partial/-wal/-shm/-journal artifacts older than the cleanup age, keeps fresh ones', async () => {
    const service = new DbBackupService();
    const old = path.join(backupDir, 'argus_old_orphan.db.partial');
    const oldWal = path.join(backupDir, 'argus_old_orphan.db.partial-wal');
    const fresh = path.join(backupDir, 'argus_fresh_orphan.db.partial');
    fs.writeFileSync(old, 'abandoned mid-copy');
    fs.writeFileSync(oldWal, 'abandoned mid-copy wal');
    fs.writeFileSync(fresh, 'copy in progress right now');
    const oldTime = Date.now() - 2 * 60 * 60 * 1000; // 2h ago, beyond ORPHAN_CLEANUP_AGE_MS (1h default)
    fs.utimesSync(old, oldTime / 1000, oldTime / 1000);
    fs.utimesSync(oldWal, oldTime / 1000, oldTime / 1000);

    await service.runBackup();

    expect(fs.existsSync(old)).toBe(false); // swept - no restore value, old enough
    expect(fs.existsSync(oldWal)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true); // too young to assume abandoned
    fs.rmSync(fresh, { force: true }); // cleanup for subsequent tests in this suite
  });

  it('caps published backups by count even when all are within the age retention window', async () => {
    const service = new DbBackupService();
    // Seed 6 fake published backups, deliberately older than anything else this suite creates
    // (10-15min back - the whole suite runs in well under that), to isolate the count cap
    // (default 5) from the age-based rule without assuming isolation from earlier tests' own
    // real backups sharing this same directory.
    const seeded: string[] = [];
    for (let i = 0; i < 6; i++) {
      const f = path.join(backupDir, `argus_seed_${i}.db`);
      fs.writeFileSync(f, 'seed');
      const t = Date.now() - (15 - i) * 60 * 1000; // staggered, oldest first, all well in the past
      fs.utimesSync(f, t / 1000, t / 1000);
      seeded.push(f);
    }

    const newest = await service.runBackup(); // newest published backup in the directory

    const totalPublished = fs.readdirSync(backupDir).filter(isPublishedName);
    expect(totalPublished.length).toBeLessThanOrEqual(5); // MAX_COUNT, regardless of how many pre-existed
    expect(fs.existsSync(newest)).toBe(true); // newest always survives the count cap
    expect(fs.existsSync(seeded[0])).toBe(false); // oldest file in the whole directory, pruned first
  });

  it('preserves same-day snapshots and propagates failure without publishing a partial backup', async () => {
    const service = new DbBackupService();
    const first = await service.runBackup();
    const second = await service.runBackup();
    expect(first).not.toBe(second);
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(second)).toBe(true);
    const before = fs.readdirSync(backupDir).sort();
    const { sqliteDb } = await import('../db');
    const fail = vi.spyOn(sqliteDb, 'backup').mockRejectedValueOnce(new Error('injected backup failure'));
    try {
      await expect(service.runBackup()).rejects.toThrow('injected backup failure');
      expect(fs.readdirSync(backupDir).sort()).toEqual(before);
    } finally { fail.mockRestore(); }
  });

  it('backs up real data, survives real deletion of the "live" file, and restores it byte-for-byte-verifiable', async () => {
    // Seed the "live" DB with real, checkable data (a whole real trading domain table would work
    // too, but a minimal real table proves the mechanism without depending on the full schema).
    const { db, sqliteDb } = await import('../db');
    const schema = await import('../db/schema');
    await db.insert(schema.settings).values({ maxTradeSize: 1234, riskLevel: 'Aggressive' });

    const service = new DbBackupService();
    const start = Date.now();
    const backupFile = await service.runBackup();
    const backupDurationMs = Date.now() - start;

    const stamp = new Date().toISOString().slice(0, 10);
    expect(fs.existsSync(backupFile)).toBe(true);

    // Independently verify the backup's integrity with a completely separate connection - the
    // same discipline used during the real incident (never trust a copy without checking it).
    const verify = new Database(backupFile, { readonly: true });
    const integrity = verify.prepare('PRAGMA integrity_check').get() as any;
    expect(integrity.integrity_check).toBe('ok');
    const [settingsRow] = verify.prepare('SELECT max_trade_size, risk_level FROM settings LIMIT 1').all() as any[];
    expect(settingsRow.max_trade_size).toBe(1234);
    expect(settingsRow.risk_level).toBe('Aggressive');
    verify.close();

    // REAL destructive step: delete the "live" file entirely (isolated temp file, never the real
    // data/argus.db), simulating the exact incident this test exists to prevent a recurrence of.
    // On Windows (unlike POSIX), a file with an open handle can't be unlinked - close the live
    // connection first, matching the exact "delete-pending" semantics CLAUDE.md documents from
    // the real incident this test is modeled on.
    sqliteDb.close();
    fs.unlinkSync(liveDbPath);
    for (const suffix of ['-wal', '-shm']) { try { fs.unlinkSync(liveDbPath + suffix); } catch {} }
    expect(fs.existsSync(liveDbPath)).toBe(false);

    // RESTORE: copy the verified backup back to the live path - the real, documented procedure.
    const restoreStart = Date.now();
    fs.copyFileSync(backupFile, liveDbPath);
    const restoreDurationMs = Date.now() - restoreStart;

    // VERIFY DATA after restore, via a fresh connection at the real live path.
    const restored = new Database(liveDbPath, { readonly: true });
    const restoredIntegrity = restored.prepare('PRAGMA integrity_check').get() as any;
    expect(restoredIntegrity.integrity_check).toBe('ok');
    const [restoredSettings] = restored.prepare('SELECT max_trade_size FROM settings LIMIT 1').all() as any[];
    expect(restoredSettings.max_trade_size).toBe(1234);
    restored.close();

    // Real, measured RTO for this drill's data volume - documented in FINAL_ANALYSIS.md rather
    // than asserted against an arbitrary threshold here (this is a tiny seed DB, not the real
    // live one - the number is informative, not a pass/fail gate).
    console.log(`[Backup drill] backup took ${backupDurationMs}ms, restore took ${restoreDurationMs}ms (tiny test DB - not representative of real-size RTO)`);
  });
});
