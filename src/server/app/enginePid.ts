/**
 * Process PID file for CLI-managed headless engine instances.
 * Single-process constraint: one Argus engine per data/argus.db.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const ENGINE_PID_PATH = join(process.cwd(), 'data', '.argus_engine.pid');

export function ensureDataDir(): void {
  const dir = join(process.cwd(), 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function writeEnginePid(pid: number): void {
  ensureDataDir();
  writeFileSync(ENGINE_PID_PATH, String(pid), 'utf8');
}

export function readEnginePid(): number | null {
  if (!existsSync(ENGINE_PID_PATH)) return null;
  const raw = readFileSync(ENGINE_PID_PATH, 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function clearEnginePid(): void {
  if (existsSync(ENGINE_PID_PATH)) {
    try {
      unlinkSync(ENGINE_PID_PATH);
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

/** Returns true if pid file points to a live process (best-effort, cross-platform). */
export function isEngineProcessRunning(): boolean {
  const pid = readEnginePid();
  if (!pid) return false;
  if (!isPidAlive(pid)) {
    clearEnginePid();
    return false;
  }
  return true;
}

/**
 * If a live engine exists, return its pid. If the PID file is stale, clear it.
 * Does not write a new pid.
 */
export function reconcileEnginePidFile(): { running: boolean; pid: number | null; staleCleared: boolean } {
  const pid = readEnginePid();
  if (!pid) return { running: false, pid: null, staleCleared: false };
  if (isPidAlive(pid)) return { running: true, pid, staleCleared: false };
  clearEnginePid();
  return { running: false, pid: null, staleCleared: true };
}

/** Record this process as the engine. Throws if another live engine holds the pid file. */
export function claimEnginePid(pid: number = process.pid): void {
  const existing = reconcileEnginePidFile();
  if (
    existing.running
    && existing.pid !== pid
    && existing.pid !== process.ppid
  ) {
    throw new Error(`Argus engine already running (pid ${existing.pid})`);
  }
  writeEnginePid(pid);
}

/**
 * PID-reuse safety net: isPidAlive()/isEngineProcessRunning() only prove the OS has SOME live
 * process at that number - not that it is still Argus. If the original engine crashed without
 * clearing data/.argus_engine.pid and the OS later hands that same PID to an unrelated process
 * (real risk - Windows and Linux both reuse PIDs, sometimes within the same session), every
 * caller that trusted isPidAlive() alone would treat a stranger process as "the Argus engine."
 * The worst consequence is CLI `stop` sending SIGTERM to that unrelated process. This is a
 * best-effort, additive, OUT-OF-BAND check (not folded into the synchronous isPidAlive() every
 * existing caller already relies on) - callers that care about that specific worst case (the CLI's
 * stop command) opt into awaiting it before signaling. Fails OPEN (assume it might still be Argus)
 * when the check itself can't run (non-Windows, tasklist missing, permissions) - a missed identity
 * check is not worse than the status quo before this function existed, but a wrongly-blocked
 * legitimate stop would be a real regression.
 */
export async function isPidLikelyArgusProcess(pid: number): Promise<boolean> {
  if (!isPidAlive(pid)) return false;
  if (process.platform !== 'win32') return true; // no portable, dependency-free check on POSIX here - fail open
  try {
    const { stdout } = await execFileAsync('wmic', [
      'process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine', '/value',
    ], { timeout: 5000, windowsHide: true });
    const commandLine = stdout.toLowerCase();
    if (!commandLine.includes('commandline=')) return true; // couldn't read it - fail open, don't block a real stop
    return /argus-engine|argus-engine-prod|server\.ts|server\.cjs|tsx/.test(commandLine);
  } catch {
    return true; // wmic unavailable/errored - fail open, same reasoning as above
  }
}
