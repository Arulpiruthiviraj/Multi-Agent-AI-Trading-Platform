/**
 * Generic duplicate-launch guard for optional companion processes (Java Quant Core, Chronos, ...).
 * Two independent launchers can decide to start the same companion (e.g. the headless engine
 * daemon's own launcher and the full `npm run dev` ecosystem launcher) - each already checks
 * GET /health and the raw port before spawning, but that check-then-spawn sequence is a real
 * TOCTOU race if both launchers run close together (e.g. `npm run dev` shortly after
 * `./argus start`). See javaQuantCoreLock.ts's original header (2026-08-24 readiness audit, Part 6)
 * for the incident this pattern was built to close - two java.exe processes bound to the same port.
 * Generalized here (2026-09-02) so a second companion (Chronos) gets the same protection instead
 * of reimplementing it; javaQuantCoreLock.ts now wraps this module, name-pinned to its original
 * lock file path.
 *
 * This does not replace a launcher's own health/port check (still the first, cheap line of
 * defense) - it closes the narrow window between that check and the actual spawn with an atomic,
 * exclusive-create lock file. Whichever launcher wins the race proceeds to spawn; the other detects
 * the lock, verifies the recorded PID is still alive (never blindly trusts a stale file), and either
 * waits for that real process to become healthy or - if the PID is dead - cleans the stale lock and
 * proceeds itself. Never kills anything; only ever reads/verifies process identity via signal 0.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface CompanionLockInfo {
  pid: number;
  port: number;
  startedAt: string;
}

function lockPath(repoRoot: string, lockName: string): string {
  return path.join(repoRoot, 'data', `.${lockName}_launch.lock`);
}

/** True iff a process with this PID currently exists (does not send a real signal - see Node docs for kill(pid, 0)). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(repoRoot: string, lockName: string): CompanionLockInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath(repoRoot, lockName), 'utf8'));
    if (!raw || typeof raw.pid !== 'number' || typeof raw.port !== 'number' || typeof raw.startedAt !== 'string') return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Attempts to atomically claim the launch lock for this process, under `lockName` (one lock file
 * per companion - e.g. 'quant_core_java', 'chronos'). Returns:
 *   - { acquired: true } - this call is clear to spawn; it must call releaseCompanionLaunchLock()
 *     once the spawned process's own health check settles (success or failure - the lock is only
 *     for the launch race, not a long-lived "is running" marker; GET /health remains that source of truth).
 *   - { acquired: false, holderPid } - another live process is already in the middle of launching
 *     (or has already launched) this companion; the caller should wait for HTTP health instead of
 *     spawning a second copy.
 * A stale lock (holder PID no longer alive) is detected and cleaned automatically, never assumed
 * to still be valid just because the file exists.
 */
export function acquireCompanionLaunchLock(repoRoot: string, lockName: string, port: number): { acquired: true } | { acquired: false; holderPid: number } {
  const existing = readLock(repoRoot, lockName);
  if (existing) {
    if (isPidAlive(existing.pid)) {
      return { acquired: false, holderPid: existing.pid };
    }
    // Stale PID file left by a process that died mid-launch (or crashed) - clean it up rather than
    // trusting it, then fall through to claim the lock fresh.
    try { fs.unlinkSync(lockPath(repoRoot, lockName)); } catch { /* already gone */ }
  }

  try {
    fs.mkdirSync(path.dirname(lockPath(repoRoot, lockName)), { recursive: true });
    const info: CompanionLockInfo = { pid: process.pid, port, startedAt: new Date().toISOString() };
    // 'wx' = exclusive create, fails if the file already exists - the actual atomic race-closer.
    // A concurrent writer that wins this exact race gets EEXIST here and correctly reports not-acquired.
    fs.writeFileSync(lockPath(repoRoot, lockName), JSON.stringify(info, null, 2), { flag: 'wx' });
    return { acquired: true };
  } catch {
    // Lost the exact race to another process between the stale-check above and this write.
    const afterRace = readLock(repoRoot, lockName);
    return { acquired: false, holderPid: afterRace?.pid ?? -1 };
  }
}

/** Safe to call even if this process never held the lock (e.g. acquire failed) - always best-effort. */
export function releaseCompanionLaunchLock(repoRoot: string, lockName: string): void {
  const existing = readLock(repoRoot, lockName);
  if (existing && existing.pid !== process.pid) return; // never remove another process's lock
  try { fs.unlinkSync(lockPath(repoRoot, lockName)); } catch { /* already gone */ }
}

export { isPidAlive as isCompanionLockHolderAlive };
