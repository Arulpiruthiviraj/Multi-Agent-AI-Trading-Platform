import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

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
  it('prunes backups older than the retention window, keeps recent ones', () => {
    const service = new DbBackupService();
    const oldFile = path.join(backupDir, 'argus_2020-01-01.db');
    fs.writeFileSync(oldFile, 'irrelevant content - only mtime matters for pruning');
    const oldTime = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40 days ago, beyond the 30-day retention window
    fs.utimesSync(oldFile, oldTime / 1000, oldTime / 1000);

    service.runBackup(); // real call also runs pruning as a side effect

    expect(fs.existsSync(oldFile)).toBe(false); // pruned
    const stamp = new Date().toISOString().slice(0, 10);
    expect(fs.existsSync(path.join(backupDir, `argus_${stamp}.db`))).toBe(true); // today's backup kept
  });

  it('backs up real data, survives real deletion of the "live" file, and restores it byte-for-byte-verifiable', async () => {
    // Seed the "live" DB with real, checkable data (a whole real trading domain table would work
    // too, but a minimal real table proves the mechanism without depending on the full schema).
    const { db, sqliteDb } = await import('../db');
    const schema = await import('../db/schema');
    await db.insert(schema.settings).values({ maxTradeSize: 1234, riskLevel: 'Aggressive' });

    const service = new DbBackupService();
    const start = Date.now();
    service.runBackup();
    const backupDurationMs = Date.now() - start;

    const stamp = new Date().toISOString().slice(0, 10);
    const backupFile = path.join(backupDir, `argus_${stamp}.db`);
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
