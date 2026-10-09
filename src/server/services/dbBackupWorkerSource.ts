/**
 * ==========================================================
 * Module: dbBackupWorkerSource.ts
 *
 * Purpose:
 * The worker_thread body for DbBackupService. It is stored as a plain-JS
 * source string (not a separate file) so it works identically under tsx
 * (dev/tests), vitest, and the esbuild-bundled dist/server.cjs production
 * build - a separate worker file would not survive bundling, and eval:true
 * needs no filesystem path at all.
 *
 * The worker owns the ENTIRE heavy backup pipeline: SQLite online copy,
 * integrity check, sha256 checksum, and atomic publish. The main thread only
 * orchestrates (spawn, progress log, timeout, result handling) and never
 * touches the DB bytes - this is what keeps the engine's event loop, health
 * endpoint, and trading pipeline responsive during a multi-GB backup.
 *
 * Protocol (workerData in, parentPort.postMessage out):
 *   in:  { dbPath, tempPath, finalPath }
 *   out: { type: 'progress', phase, copiedBytes, totalBytes, elapsedMs }
 *        { type: 'complete', destination, bytesCopied, sha256, durationMs }
 *        { type: 'error', phase, message, stack }
 * ==========================================================
 */

export interface DbBackupWorkerJob {
  dbPath: string;
  tempPath: string;
  finalPath: string;
}

export type DbBackupWorkerPhase = 'copy' | 'integrity' | 'checksum' | 'rename';

export type DbBackupWorkerMessage =
  | { type: 'progress'; phase: DbBackupWorkerPhase; copiedBytes: number; totalBytes: number; elapsedMs: number }
  | { type: 'complete'; destination: string; bytesCopied: number; sha256: string; durationMs: number }
  | { type: 'error'; phase: string; message: string; stack?: string };

/**
 * Plain JavaScript (no TS syntax - it is eval'd, not compiled). Keep it small
 * and dependency-light: node builtins + better-sqlite3 only.
 */
export const DB_BACKUP_WORKER_SOURCE = `
'use strict';
/*
 * dbBackupWorker - runs inside a Node worker_thread spawned with { eval: true }.
 * Receives its job via workerData; reports via parentPort.postMessage.
 */
const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const job = workerData || {};
const dbPath = job.dbPath;
const tempPath = job.tempPath;
const finalPath = job.finalPath;
const startedAt = Date.now();

let lastProgressAt = 0;
function reportProgress(phase, copiedBytes, totalBytes) {
  const now = Date.now();
  // Throttle: phase completions always reported, in-flight at most ~1/sec.
  if (now - lastProgressAt < 1000 && copiedBytes < totalBytes) return;
  lastProgressAt = now;
  parentPort.postMessage({
    type: 'progress',
    phase: phase,
    copiedBytes: copiedBytes,
    totalBytes: totalBytes,
    elapsedMs: now - startedAt,
  });
}

function fail(phase, err) {
  parentPort.postMessage({
    type: 'error',
    phase: phase,
    message: err && err.message ? err.message : String(err),
    stack: err && err.stack ? String(err.stack) : undefined,
  });
}

(async () => {
  if (!dbPath || !tempPath || !finalPath) {
    throw new Error('dbBackupWorker: workerData must contain dbPath, tempPath, finalPath');
  }

  // Phase 1: online copy. Own READ-ONLY connection - the engine's main-thread
  // connection remains the sole writer (WAL mode). If the writer holds the
  // database lock mid-step, sqlite3_backup_step returns SQLITE_BUSY and
  // better-sqlite3's transfer loop simply retries on the next tick.
  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  let totalBytes = 0;
  try {
    const pageSize = source.pragma('page_size', { simple: true });
    await source.backup(tempPath, {
      progress: (info) => {
        totalBytes = info.totalPages * pageSize;
        reportProgress('copy', (info.totalPages - info.remainingPages) * pageSize, totalBytes);
      },
    });
    reportProgress('copy', totalBytes, totalBytes);
  } finally {
    source.close();
  }

  // Phase 2: integrity check. This PRAGMA is a single synchronous C call that
  // used to block the main event loop for minutes on a 16GB database - here
  // it blocks only this worker thread.
  const verify = new Database(tempPath, { readonly: true, fileMustExist: true });
  try {
    const rows = verify.pragma('integrity_check');
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].integrity_check !== 'ok') {
      throw new Error('Backup integrity check failed');
    }
  } finally {
    verify.close();
  }
  reportProgress('integrity', 1, 1);

  // Phase 3: sha256 over the verified temp file (streaming; worker-local I/O only).
  const sha256 = await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(tempPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
  reportProgress('checksum', 1, 1);

  // Phase 4: atomic publish. rename(2) is atomic on POSIX; the destination name
  // is unique per run (uuid), so no observer ever sees a half-written final file.
  fs.renameSync(tempPath, finalPath);
  const stat = fs.statSync(finalPath);
  reportProgress('rename', 1, 1);

  parentPort.postMessage({
    type: 'complete',
    destination: finalPath,
    bytesCopied: stat.size,
    sha256: sha256,
    durationMs: Date.now() - startedAt,
  });
})().catch((err) => fail('unknown', err));
`;
