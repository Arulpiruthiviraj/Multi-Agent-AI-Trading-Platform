import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import Database from 'better-sqlite3';

/**
 * 2026-10-08 (defects #2 and #4): backup work moved off the Node main event loop into a
 * worker_thread, with disk preflight, atomic publish, orphan hygiene, and a concurrency guard.
 *
 * Uses an isolated temp directory throughout - never the real data/argus.db or data/backups/.
 * DbBackupService derives BACKUP_DIR from dbPath at import time, so ARGUS_DB_PATH is pointed at
 * the isolated file before importing (same pattern as DbBackupService.test.ts; vitest isolates
 * modules per test file, so the two suites don't share the module instance).
 */

describe('DbBackupService worker-thread execution (2026-10-08)', () => {
  let tmpRoot: string;
  let liveDbPath: string;
  let backupDir: string;
  let DbBackupService: any;
  let BackupAlreadyRunningError: any;

  const buildSyntheticDb = (sizeMb: number) => {
    if (fs.existsSync(liveDbPath)) fs.unlinkSync(liveDbPath);
    const filler = new Database(liveDbPath);
    try {
      filler.exec('CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB)');
      const insert = filler.prepare('INSERT INTO blobs (data) VALUES (?)');
      const oneMb = crypto.randomBytes(1024 * 1024);
      const txn = filler.transaction(() => {
        for (let i = 0; i < sizeMb; i++) insert.run(oneMb);
      });
      txn();
    } finally {
      filler.close();
    }
  };

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'argus_backupworker_'));
    liveDbPath = path.join(tmpRoot, 'argus.db');
    backupDir = path.join(tmpRoot, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });

    process.env.ARGUS_DB_PATH = liveDbPath;
    ({ DbBackupService, BackupAlreadyRunningError } = await import('./DbBackupService'));
  });

  afterAll(() => {
    delete process.env.ARGUS_DB_PATH;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('(a) the main event loop stays responsive during a large backup - heartbeat never stalls', async () => {
    buildSyntheticDb(120); // ~120MB synthetic DB: copy + integrity_check + sha256 take real seconds
    const service = new DbBackupService();

    const gaps: number[] = [];
    let last = Date.now();
    const heartbeat = setInterval(() => {
      const now = Date.now();
      gaps.push(now - last);
      last = now;
    }, 25);

    let sawRunning = false;
    const runPromise = service.runBackup();
    // The state machine must report RUNNING (the watchdog's "maintenance in progress" contract)
    // while the worker is busy.
    await vi.waitFor(() => {
      if (service.isMaintenanceInProgress()) sawRunning = true;
      expect(service.isMaintenanceInProgress()).toBe(true);
    }, { timeout: 15000 });
    const result = await runPromise;
    clearInterval(heartbeat);

    expect(sawRunning).toBe(true);
    expect(result.outcome).toBe('completed');
    if (result.outcome !== 'completed') throw new Error('test setup failed');
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.bytesCopied).toBeGreaterThan(100 * 1024 * 1024);
    expect(fs.existsSync(result.destination)).toBe(true);

    // The published backup is a real, independently-verifiable copy.
    const verify = new Database(result.destination, { readonly: true });
    try {
      const integrity = verify.prepare('PRAGMA integrity_check').get() as any;
      expect(integrity.integrity_check).toBe('ok');
      const count = verify.prepare('SELECT COUNT(*) AS n FROM blobs').get() as any;
      expect(count.n).toBe(120);
    } finally {
      verify.close();
    }

    // Heartbeat proof: with the old in-process design, PRAGMA integrity_check alone blocked
    // the loop for minutes on a DB this size. Here the loop must never stall badly.
    expect(gaps.length).toBeGreaterThan(10); // backup actually took measurable time
    const maxGap = Math.max(...gaps);
    expect(maxGap).toBeLessThan(1000);
    expect(service.isMaintenanceInProgress()).toBe(false);
    expect(service.getBackupStatus().state).toBe('SUCCEEDED');
  }, 120000);

  it('(b) orphan sweep removes stale .partial artifacts but never the current in-progress temp', async () => {
    const service = new DbBackupService();
    const stalePid = path.join(backupDir, 'argus_stale.db.partial.99999.abcdef12');
    const staleLegacy = path.join(backupDir, 'argus_stale_legacy.db.partial');
    const staleWal = path.join(backupDir, 'argus_stale_legacy.db.partial-wal');
    const fresh = path.join(backupDir, `argus_fresh.db.partial.${process.pid}.live0001`);
    for (const f of [stalePid, staleLegacy, staleWal, fresh]) fs.writeFileSync(f, 'x');
    const oldTime = Date.now() - 2 * 60 * 60 * 1000; // 2h, beyond the 1h grace window
    for (const f of [stalePid, staleLegacy, staleWal]) fs.utimesSync(f, oldTime / 1000, oldTime / 1000);

    // Simulate the worker's live output: tracked by basename, must survive even if old.
    const liveTemp = `argus_live.db.partial.${process.pid}.live0002`;
    const liveTempPath = path.join(backupDir, liveTemp);
    fs.writeFileSync(liveTempPath, 'worker is writing this right now');
    fs.utimesSync(liveTempPath, oldTime / 1000, oldTime / 1000); // old mtime must NOT matter
    (service as any).currentTempBasename = liveTemp;

    await (service as any).sweepOrphanArtifacts('startup');

    expect(fs.existsSync(stalePid)).toBe(false); // stale pid/nonce temp swept
    expect(fs.existsSync(staleLegacy)).toBe(false); // legacy shape still swept
    expect(fs.existsSync(staleWal)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true); // too young to assume abandoned
    expect(fs.existsSync(liveTempPath)).toBe(true); // current worker output never deleted
    fs.rmSync(fresh, { force: true });
    fs.rmSync(liveTempPath, { force: true });
  });

  it('(c) disk-preflight skip triggers under simulated low disk and emits a loud diagnostic', async () => {
    buildSyntheticDb(2);
    let workerSpawned = false;
    const service = new DbBackupService({
      createWorker: () => { workerSpawned = true; throw new Error('must not spawn'); },
    });
    (service as any).getFreeDiskSpaceBytes = async () => 1; // 1 byte free - far below 2x DB size

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: any[]) => { errors.push(args.map(String).join(' ')); };
    let result: any;
    const before = new Set(fs.readdirSync(backupDir));
    try {
      result = await service.runBackup();
    } finally {
      console.error = origError;
    }

    expect(workerSpawned).toBe(false); // no worker, no copy, no disk written
    expect(result.outcome).toBe('skipped_disk');
    expect(result.reason).toMatch(/below the required/);
    const status = service.getBackupStatus();
    expect(status.state).toBe('SKIPPED_DISK');
    expect(status.skipReason).toBeTruthy();
    const logged = errors.join('\n');
    expect(logged).toMatch(/BACKUP SKIPPED - LOW DISK SPACE/);
    // No published backup may appear from a skipped run (compare against the
    // pre-existing files left by earlier tests in this shared temp dir).
    const fresh = fs.readdirSync(backupDir).filter((f) => !before.has(f));
    expect(fresh.filter((f) => f.startsWith('argus_') && f.endsWith('.db'))).toHaveLength(0);
    expect(fresh).toHaveLength(0); // the skip must not write anything at all
  });

  it('(d) a second concurrent backup is rejected while one is running', async () => {
    buildSyntheticDb(40);
    const service = new DbBackupService();

    const first = service.runBackup();
    await vi.waitFor(() => expect(service.getBackupStatus().state).toBe('RUNNING'), { timeout: 15000 });

    await expect(service.runBackup()).rejects.toBeInstanceOf(BackupAlreadyRunningError);
    // The first run is unaffected by the rejected second call.
    const result = await first;
    expect(result.outcome).toBe('completed');
    expect(service.getBackupStatus().state).toBe('SUCCEEDED');
  }, 120000);

  it('(e) worker crash publishes nothing - no half-written final file is ever visible', async () => {
    buildSyntheticDb(2);
    let crashedTempPath: string | null = null;
    const service = new DbBackupService({
      createWorker: (source: string, options: { workerData: any }) => {
        crashedTempPath = options.workerData.tempPath;
        const listeners: Record<string, Array<(...a: any[]) => void>> = { message: [], error: [], exit: [] };
        setImmediate(() => {
          // Simulate a worker dying mid-copy: it managed to write garbage to the temp path,
          // then the process died before integrity check / rename.
          fs.writeFileSync(options.workerData.tempPath, 'half-written garbage');
          for (const cb of listeners.exit) cb(1);
        });
        return {
          on(event: 'message' | 'error' | 'exit', cb: (...a: any[]) => void) { listeners[event].push(cb); return this; },
          terminate: async () => 1,
        };
      },
    });

    const publishedBefore = new Set(
      fs.readdirSync(backupDir).filter((f) => f.startsWith('argus_') && f.endsWith('.db')),
    );

    await expect(service.runBackup()).rejects.toThrow(/exited with code 1/);
    expect(service.getBackupStatus().state).toBe('FAILED');

    // Atomic-publish invariant: the final name only ever appears via rename-on-success.
    // (Earlier tests in this file published real backups into the shared temp dir;
    // assert none were ADDED by the crashed run.)
    const freshPublished = fs.readdirSync(backupDir).filter(
      (f) => !publishedBefore.has(f) && f.startsWith('argus_') && f.endsWith('.db'),
    );
    expect(freshPublished).toHaveLength(0);
    // The service removes the crashed run's OWN temp (best-effort) — no half-written
    // artifact is left behind under either the final OR the temp name. Orphan temps
    // from a whole-process crash (never reaching this cleanup) are the orphan sweep's
    // job, covered by DbBackupService.test.ts's sweep cases.
    expect(crashedTempPath).toBeTruthy();
    expect(fs.existsSync(crashedTempPath as string)).toBe(false);
  });

  it('worker error message propagates as backup failure with the phase named', async () => {
    buildSyntheticDb(2);
    const service = new DbBackupService({
      createWorker: () => {
        const listeners: Record<string, Array<(...a: any[]) => void>> = { message: [], error: [], exit: [] };
        setImmediate(() => {
          for (const cb of listeners.message) cb({ type: 'error', phase: 'integrity', message: 'Backup integrity check failed' });
        });
        return {
          on(event: 'message' | 'error' | 'exit', cb: (...a: any[]) => void) { listeners[event].push(cb); return this; },
          terminate: async () => 0,
        };
      },
    });

    await expect(service.runBackup()).rejects.toThrow(/integrity.*Backup integrity check failed/);
    expect(service.getBackupStatus().state).toBe('FAILED');
  });
});
