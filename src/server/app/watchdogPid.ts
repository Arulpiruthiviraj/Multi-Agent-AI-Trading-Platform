/**
 * Process PID file for the CLI-managed detached Argus watchdog (scripts/argusWatchdog.ts).
 * Mirrors enginePid.ts's pattern for the engine itself - see that file's header for why an
 * override-per-call (not a cached module-load constant) matters for test isolation.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_WATCHDOG_PID_PATH = join(process.cwd(), 'data', '.argus_watchdog.pid');

export function resolveWatchdogPidPath(): string {
  const override = process.env.ARGUS_WATCHDOG_PID_PATH?.trim();
  return override || DEFAULT_WATCHDOG_PID_PATH;
}

function ensureDataDir(): void {
  const dir = join(process.cwd(), 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function writeWatchdogPid(pid: number): void {
  ensureDataDir();
  writeFileSync(resolveWatchdogPidPath(), String(pid), 'utf8');
}

export function readWatchdogPid(): number | null {
  const path = resolveWatchdogPidPath();
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function clearWatchdogPid(): void {
  const path = resolveWatchdogPidPath();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      /* best effort */
    }
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Returns true if the pid file points to a live process (best-effort). Clears a stale file. */
export function isWatchdogProcessRunning(): boolean {
  const pid = readWatchdogPid();
  if (!pid) return false;
  if (!isPidAlive(pid)) {
    clearWatchdogPid();
    return false;
  }
  return true;
}
