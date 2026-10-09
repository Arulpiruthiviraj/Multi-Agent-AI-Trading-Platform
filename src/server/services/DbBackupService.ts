/**
 * ==========================================================
 * Module: DbBackupService.ts
 *
 * Purpose:
 * Daily snapshot of data/argus.db so a corrupted or deleted
 * database file doesn't mean losing all trade/portfolio history.
 *
 * 2026-10-08 redesign (defects #2 and #4 from the 2026-10-08 live PAPER
 * session): ALL heavy backup work now runs in a dedicated worker_thread
 * (see dbBackupWorkerSource.ts) - the SQLite online copy, the integrity
 * check, the sha256 checksum, and the atomic publish. Previously the
 * multi-GB copy ran via sqliteDb.backup() on the main thread and - worse -
 * PRAGMA integrity_check ran as one synchronous C call, blocking the Node
 * event loop for minutes; the health endpoint went unresponsive mid-backup.
 * The main thread now only orchestrates: preflight checks, spawn, progress
 * logging, timeout, and result handling.
 *
 * Uses SQLite's online backup API (in the worker, on its own read-only
 * connection - the engine's main-thread connection remains the sole writer),
 * including committed WAL data. A unique temporary file (pid + nonce in the
 * name) is integrity-checked before atomic publication. Failed snapshots
 * never replace earlier backups.
 *
 * Cross-workstream contract (watchdog agent): isMaintenanceInProgress()
 * reports whether a backup is currently running; getBackupStatus() exposes
 * the full IDLE/RUNNING/SUCCEEDED/FAILED/SKIPPED_DISK state machine for
 * diagnostics. The state only leaves RUNNING when the worker reports
 * completion/failure, times out, or crashes - so "RUNNING" also covers the
 * in-worker integrity check (never start a second backup while one is
 * RUNNING).
 * ==========================================================
 */
import fs from 'fs/promises';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { dbPath } from '../db';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { createSingleFlightGuard } from '../core/singleFlightInterval';
import {
  DB_BACKUP_WORKER_SOURCE,
  DbBackupWorkerJob,
  DbBackupWorkerMessage,
} from './dbBackupWorkerSource';

const BACKUP_DIR = path.join(path.dirname(dbPath), 'backups');
const INTERVAL_MS = runtimeIntervals.dbBackupIntervalMs;
const RETENTION_DAYS = runtimeIntervals.dbBackupRetentionDays;
const MAX_COUNT = runtimeIntervals.dbBackupMaxCount;
const ORPHAN_CLEANUP_AGE_MS = runtimeIntervals.dbBackupOrphanCleanupAgeMs;
const MIN_FREE_SPACE_MULTIPLIER = runtimeIntervals.dbBackupMinFreeSpaceMultiplier;
const WORKER_TIMEOUT_MS = runtimeIntervals.dbBackupWorkerTimeoutMs;

/** A completed, published backup - the only kind pruning by age/count should ever consider. */
function isPublishedBackupName(file: string): boolean {
  return file.startsWith('argus_') && file.endsWith('.db');
}

/** Anything left behind by an interrupted copy (crash/restart mid-backup). Temp names carry
 *  `.<pid>.<nonce>` so a sweep can tell an abandoned temp from anything else; the legacy bare
 *  `.partial` / `.partial-wal` / `.partial-shm` / `.partial-journal` shapes from before the
 *  2026-10-08 redesign are still matched so old orphans keep getting swept. Once abandoned these
 *  have zero restore value regardless of the 30-day/max-count retention rules below. */
function isOrphanArtifactName(file: string): boolean {
  return /\.partial(\.\d+\.[0-9a-f-]+)?(-wal|-shm|-journal)?$/.test(file);
}

/** Backup lifecycle state. SUCCEEDED/FAILED/SKIPPED_DISK are terminal for a run; IDLE means no
 *  run has completed yet (or the service was just constructed). */
export type DbBackupState = 'IDLE' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED_DISK';

export interface DbBackupStatus {
  state: DbBackupState;
  /** uuid of the current/last run - correlates logs across the worker boundary. */
  runId: string | null;
  startedAtIso: string | null;
  finishedAtIso: string | null;
  lastDurationMs: number | null;
  destination: string | null;
  sha256: string | null;
  bytesCopied: number | null;
  lastError: string | null;
  /** Set when state === 'SKIPPED_DISK' - the human-readable reason, also logged loudly. */
  skipReason: string | null;
}

export type DbBackupOutcome =
  | { outcome: 'completed'; destination: string; sha256: string; bytesCopied: number; durationMs: number }
  | { outcome: 'skipped_disk'; reason: string };

export class BackupAlreadyRunningError extends Error {
  constructor() {
    super('A database backup is already running - concurrent backups are not allowed');
    this.name = 'BackupAlreadyRunningError';
  }
}

/** Minimal worker surface the service needs - injectable so tests can simulate worker
 *  crashes/hangs without real threads. */
export interface BackupWorkerLike {
  on(event: 'message' | 'error' | 'exit', listener: (...args: any[]) => void): this;
  terminate(): Promise<number>;
}
export type BackupWorkerFactory = (source: string, options: { eval: boolean; workerData: DbBackupWorkerJob }) => BackupWorkerLike;

const defaultWorkerFactory: BackupWorkerFactory = (source, options) =>
  new Worker(source, { eval: true, workerData: options.workerData }) as unknown as BackupWorkerLike;

export interface DbBackupServiceDeps {
  createWorker?: BackupWorkerFactory;
}

const PROGRESS_LOG_INTERVAL_MS = 30_000;

export class DbBackupService {
  private intervalId: NodeJS.Timeout | null = null;
  // Coalesce scheduled snapshots. Direct callers receive a unique destination or a rejection.
  private backupGuard = createSingleFlightGuard((e) => console.error('[DbBackupService] Backup cycle failed', e));
  private readonly createWorker: BackupWorkerFactory;

  private status: DbBackupStatus = {
    state: 'IDLE',
    runId: null,
    startedAtIso: null,
    finishedAtIso: null,
    lastDurationMs: null,
    destination: null,
    sha256: null,
    bytesCopied: null,
    lastError: null,
    skipReason: null,
  };
  /** Basename of the temp file the current run's worker is writing (if any). The orphan sweep
   *  never touches it - defense against deleting a live worker's output. */
  private currentTempBasename: string | null = null;
  private activeWorker: BackupWorkerLike | null = null;
  private lastProgressLogAt = 0;
  private lastProgressPhase: string | null = null;

  constructor(deps: DbBackupServiceDeps = {}) {
    this.createWorker = deps.createWorker ?? defaultWorkerFactory;
  }

  /** Cross-workstream contract (watchdog): true while a backup - including its in-worker
   *  integrity check - is in flight. The watchdog's "maintenance in progress" check reads this. */
  isMaintenanceInProgress(): boolean {
    return this.status.state === 'RUNNING';
  }

  getBackupStatus(): DbBackupStatus {
    return { ...this.status };
  }

  start() {
    if (this.intervalId) return;
    if (!existsSync(BACKUP_DIR)) {
      // mkdir itself is cheap/near-instant (creating one directory) - not the same risk class as
      // copying a multi-GB file; left synchronous for startup-ordering simplicity.
      mkdirSync(BACKUP_DIR, { recursive: true });
    }
    // 2026-10-08: sweep orphans on startup (defect #4 - a restart is exactly when a previous
    // run's .partial is guaranteed abandoned), in addition to the sweep before each backup.
    void this.sweepOrphanArtifacts('startup');
    // 2026-10-07 defect fix: start() previously ran an unconditional immediate backup on every
    // call, independent of INTERVAL_MS - confirmed live, 5 process restarts in one day produced 5
    // immediate multi-GB backup attempts clustered within hours, far more often than the intended
    // daily cadence. Skip the immediate run if a published backup already exists younger than the
    // interval; the setInterval timer below still fires on schedule either way.
    void this.maybeRunInitialBackup();
    this.intervalId = setInterval(() => { void this.backupGuard.run(async () => { await this.runBackup(); }); }, INTERVAL_MS);
    console.log("[DbBackupService] Daily DB backup scheduled (worker-thread execution).");
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
    // If a worker is mid-backup during shutdown, terminate it: its temp file is left behind
    // (never published - publish is an atomic rename the worker performs only on success) and
    // will be swept as an orphan on the next startup.
    if (this.activeWorker) {
      const worker = this.activeWorker;
      this.activeWorker = null;
      void worker.terminate().catch(() => {});
      console.log('[DbBackupService] Terminated in-flight backup worker during shutdown.');
    }
  }

  /**
   * Runs one backup cycle in a worker thread. Returns the outcome; throws on failure or when a
   * backup is already running (concurrent backups are never allowed - use the scheduled path's
   * single-flight guard for coalescing instead).
   */
  async runBackup(): Promise<DbBackupOutcome> {
    if (this.status.state === 'RUNNING') {
      throw new BackupAlreadyRunningError();
    }
    const runId = randomUUID();
    const startedAt = Date.now();

    // 2026-10-08 (defect #4): sweep before every backup as well as on startup.
    await this.sweepOrphanArtifacts('pre-backup');

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `argus_${stamp}_${randomUUID()}.db`);
    // Temp name carries pid + nonce: the sweep can identify (and never delete) the live
    // worker's current output, and stale temps from crashed processes are unambiguous.
    const temporary = `${dest}.partial.${process.pid}.${randomUUID().slice(0, 8)}`;
    this.currentTempBasename = path.basename(temporary);

    try {
      if (!existsSync(dbPath)) {
        throw new Error('No database file to back up');
      }
      await fs.mkdir(BACKUP_DIR, { recursive: true });

      // 2026-10-07 defect fix, 2026-10-08 rework: previously nothing checked free disk space
      // before starting a multi-GB copy - confirmed live, the disk ran to exactly 0 bytes free
      // partway through a backup attempt. Now a low-disk condition SKIPS the backup loudly
      // (SKIPPED_DISK state + unmissable log line) instead of either filling the disk or
      // masquerading as a generic backup failure.
      const dbStat = await fs.stat(dbPath);
      const free = await this.getFreeDiskSpaceBytes(path.dirname(dbPath));
      if (free !== null && free < dbStat.size * MIN_FREE_SPACE_MULTIPLIER) {
        const reason =
          `${Math.round(free / 1e9)}GB free on the backup filesystem is below the required ` +
          `${MIN_FREE_SPACE_MULTIPLIER}x of the live DB's ${Math.round(dbStat.size / 1e9)}GB size ` +
          `(${Math.round(dbStat.size / 1e9)}GB). Backup skipped - no copy started, no disk written.`;
        this.status = {
          ...this.status,
          state: 'SKIPPED_DISK',
          runId,
          startedAtIso: new Date(startedAt).toISOString(),
          finishedAtIso: new Date().toISOString(),
          lastDurationMs: Date.now() - startedAt,
          lastError: null,
          skipReason: reason,
        };
        console.error(`[DbBackupService] BACKUP SKIPPED - LOW DISK SPACE: ${reason}`);
        console.error('[DbBackupService] BACKUP SKIPPED - LOW DISK SPACE: free space or reduce retention before the next scheduled run.');
        return { outcome: 'skipped_disk', reason };
      }

      this.status = {
        ...this.status,
        state: 'RUNNING',
        runId,
        startedAtIso: new Date(startedAt).toISOString(),
        finishedAtIso: null,
        lastDurationMs: null,
        lastError: null,
        skipReason: null,
      };
      this.lastProgressLogAt = 0;
      this.lastProgressPhase = null;
      console.log(`[DbBackupService] Starting backup in worker thread (run ${runId}).`);

      const job: DbBackupWorkerJob = { dbPath, tempPath: temporary, finalPath: dest };
      const result = await this.runBackupWorker(job);

      this.status = {
        ...this.status,
        state: 'SUCCEEDED',
        finishedAtIso: new Date().toISOString(),
        lastDurationMs: Date.now() - startedAt,
        destination: dest,
        sha256: result.sha256,
        bytesCopied: result.bytesCopied,
      };
      console.log(`[DbBackupService] Backed up database to ${dest} (${(result.bytesCopied / 1e9).toFixed(2)}GB, sha256 ${result.sha256.slice(0, 16)}..., worker ${result.durationMs}ms)`);
      return {
        outcome: 'completed',
        destination: dest,
        sha256: result.sha256,
        bytesCopied: result.bytesCopied,
        durationMs: Date.now() - startedAt,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.status = {
        ...this.status,
        state: 'FAILED',
        finishedAtIso: new Date().toISOString(),
        lastDurationMs: Date.now() - startedAt,
        lastError: message,
      };
      // Best-effort removal of THIS run's temp only (never another run's): a crashed worker's
      // leftovers are handled by the orphan sweep (grace window), not here.
      await fs.unlink(temporary).catch(() => {});
      console.error("[DbBackupService] Backup failed:", e);
      throw e;
    } finally {
      this.currentTempBasename = null;
      // 2026-10-07 defect fix: previously only ran after a successful backup, so a run of failed
      // days never pruned anything. Always runs, success or failure, and never throws past this
      // method.
      await this.pruneOldBackups();
    }
  }

  /** Spawns the worker and resolves when it reports completion. The main thread does no I/O
   *  heavier than message handling here - the event loop stays free for the whole run. */
  private runBackupWorker(job: DbBackupWorkerJob): Promise<{ sha256: string; bytesCopied: number; durationMs: number }> {
    return new Promise((resolve, reject) => {
      let worker: BackupWorkerLike;
      try {
        worker = this.createWorker(DB_BACKUP_WORKER_SOURCE, { eval: true, workerData: job });
      } catch (e) {
        reject(e);
        return;
      }
      this.activeWorker = worker;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.activeWorker = null;
        fn();
      };
      const timeout = setTimeout(() => {
        finish(() => {
          void worker.terminate().catch(() => {});
          reject(new Error(`Backup worker timed out after ${WORKER_TIMEOUT_MS}ms without completing`));
        });
      }, WORKER_TIMEOUT_MS);
      // unref so a hung worker can't keep the process alive past shutdown on its own; stop()
      // still terminates it explicitly.
      (timeout as unknown as { unref?: () => void }).unref?.();

      worker.on('message', (msg: DbBackupWorkerMessage) => {
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'progress') {
          this.logWorkerProgress(msg);
        } else if (msg.type === 'complete') {
          finish(() => resolve({ sha256: msg.sha256, bytesCopied: msg.bytesCopied, durationMs: msg.durationMs }));
        } else if (msg.type === 'error') {
          finish(() => reject(new Error(`Backup worker failed during '${msg.phase}': ${msg.message}`)));
        }
      });
      worker.on('error', (err: unknown) => {
        finish(() => reject(err instanceof Error ? err : new Error(`Backup worker error: ${String(err)}`)));
      });
      worker.on('exit', (code: number) => {
        finish(() => reject(new Error(`Backup worker exited with code ${code} before reporting completion`)));
      });
    });
  }

  private logWorkerProgress(msg: Extract<DbBackupWorkerMessage, { type: 'progress' }>): void {
    const now = Date.now();
    const phaseChanged = msg.phase !== this.lastProgressPhase;
    if (!phaseChanged && now - this.lastProgressLogAt < PROGRESS_LOG_INTERVAL_MS) return;
    this.lastProgressLogAt = now;
    this.lastProgressPhase = msg.phase;
    const pct = msg.totalBytes > 0 ? ` (${Math.round((100 * msg.copiedBytes) / msg.totalBytes)}%)` : '';
    console.log(`[DbBackupService] Backup worker phase '${msg.phase}'${pct} - ${Math.round(msg.elapsedMs / 1000)}s elapsed (main event loop unaffected).`);
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

  /**
   * Removes orphaned .partial artifacts older than ORPHAN_CLEANUP_AGE_MS. Runs on startup and
   * before each backup. Never touches the current run's temp file (tracked by basename), and a
   * genuinely in-progress copy is always younger than the grace window. Every removal is logged.
   */
  private async sweepOrphanArtifacts(reason: 'startup' | 'pre-backup'): Promise<void> {
    let files: string[];
    try {
      files = await fs.readdir(BACKUP_DIR);
    } catch {
      return; // directory doesn't exist yet - nothing to sweep
    }
    for (const file of files) {
      if (!isOrphanArtifactName(file)) continue;
      if (file === this.currentTempBasename) continue; // live worker output - never delete
      const full = path.join(BACKUP_DIR, file);
      try {
        const st = await fs.stat(full);
        if (Date.now() - st.mtimeMs >= ORPHAN_CLEANUP_AGE_MS) {
          await fs.unlink(full);
          console.log(`[DbBackupService] Swept orphaned backup artifact ${file} (${reason}, age ${Math.round((Date.now() - st.mtimeMs) / 60000)}min)`);
        }
      } catch { /* file may have been cleaned up concurrently - not an error */ }
    }
  }

  private async pruneOldBackups(): Promise<void> {
    try {
      // Orphan sweep also runs here as a second-order safety net (this method runs in
      // runBackup's finally, after this run's own copy already finished or failed).
      await this.sweepOrphanArtifacts('pre-backup');

      const files = await fs.readdir(BACKUP_DIR);

      // Published backups: prune by whichever of (age, count) is more restrictive. Day-based
      // retention alone is unsustainable once the DB is multi-GB (30 days x ~13GB observed would
      // be ~390GB) - the count cap is what actually bounds disk usage in practice.
      // Retention policy is unchanged by the 2026-10-08 redesign: same age cutoff, same count
      // cap, every deletion logged.
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
