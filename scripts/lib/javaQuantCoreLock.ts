/**
 * Shared duplicate-launch guard for the Java Quant Core companion (2026-08-24 readiness audit,
 * Part 6). Two independent launchers can decide to start this companion (the headless engine
 * daemon's javaQuantCoreLauncher.ts, and the full ecosystem's devWithOpenAlice.ts) - each already
 * checks GET /health and the raw port before spawning, but that check-then-spawn sequence is a
 * real TOCTOU race if both launchers run close together (e.g. `npm run dev` shortly after
 * `./argus start`): both can see "not healthy yet" and each spawn its own process, which is exactly
 * the duplicate this session found live (two java.exe processes bound to the same port).
 *
 * This does not replace either launcher's own health/port check (still the first, cheap line of
 * defense) - it closes the narrow window between that check and the actual spawn with an atomic,
 * exclusive-create lock file. Whichever launcher wins the race proceeds to spawn; the other detects
 * the lock, verifies the recorded PID is still alive (never blindly trusts a stale file), and either
 * waits for that real process to become healthy or - if the PID is dead - cleans the stale lock and
 * proceeds itself. Never kills anything; only ever reads/verifies process identity via signal 0.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface JavaQuantCoreLockInfo {
  pid: number;
  port: number;
  startedAt: string;
}

function lockPath(repoRoot: string): string {
  return path.join(repoRoot, 'data', '.quant_core_java_launch.lock');
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

function readLock(repoRoot: string): JavaQuantCoreLockInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath(repoRoot), 'utf8'));
    if (!raw || typeof raw.pid !== 'number' || typeof raw.port !== 'number' || typeof raw.startedAt !== 'string') return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Attempts to atomically claim the launch lock for this process. Returns:
 *   - { acquired: true } - this call is clear to spawn; it must call releaseJavaQuantCoreLaunchLock()
 *     once the spawned process's own health check settles (success or failure - the lock is only
 *     for the launch race, not a long-lived "is running" marker; GET /health remains that source of truth).
 *   - { acquired: false, holderPid } - another live process is already in the middle of launching
 *     (or has already launched) this companion; the caller should wait for HTTP health instead of
 *     spawning a second copy.
 * A stale lock (holder PID no longer alive) is detected and cleaned automatically, never assumed
 * to still be valid just because the file exists.
 */
export function acquireJavaQuantCoreLaunchLock(repoRoot: string, port: number): { acquired: true } | { acquired: false; holderPid: number } {
  const existing = readLock(repoRoot);
  if (existing) {
    if (isPidAlive(existing.pid)) {
      return { acquired: false, holderPid: existing.pid };
    }
    // Stale PID file left by a process that died mid-launch (or crashed) - clean it up rather than
    // trusting it, then fall through to claim the lock fresh.
    try { fs.unlinkSync(lockPath(repoRoot)); } catch { /* already gone */ }
  }

  try {
    fs.mkdirSync(path.dirname(lockPath(repoRoot)), { recursive: true });
    const info: JavaQuantCoreLockInfo = { pid: process.pid, port, startedAt: new Date().toISOString() };
    // 'wx' = exclusive create, fails if the file already exists - the actual atomic race-closer.
    // A concurrent writer that wins this exact race gets EEXIST here and correctly reports not-acquired.
    fs.writeFileSync(lockPath(repoRoot), JSON.stringify(info, null, 2), { flag: 'wx' });
    return { acquired: true };
  } catch {
    // Lost the exact race to another process between the stale-check above and this write.
    const afterRace = readLock(repoRoot);
    return { acquired: false, holderPid: afterRace?.pid ?? -1 };
  }
}

/** Safe to call even if this process never held the lock (e.g. acquire failed) - always best-effort. */
export function releaseJavaQuantCoreLaunchLock(repoRoot: string): void {
  const existing = readLock(repoRoot);
  if (existing && existing.pid !== process.pid) return; // never remove another process's lock
  try { fs.unlinkSync(lockPath(repoRoot)); } catch { /* already gone */ }
}

export { isPidAlive as isJavaQuantCoreLockHolderAlive };
