/**
 * Process PID file for CLI-managed headless engine instances.
 * Single-process constraint: one Argus engine per data/argus.db.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_ENGINE_PID_PATH = join(process.cwd(), 'data', '.argus_engine.pid');

/**
 * Real bug found and fixed (2026-08-25, E2E/CLI investigation): this was a static `const`
 * evaluated once against the real repo cwd, with no override - so enginePid.test.ts and
 * gracefulShutdown.test.ts (neither of which mocked this module) read/wrote/deleted the actual
 * developer-facing data/.argus_engine.pid on every test run, including gracefulShutdown.test.ts's
 * unconditional clearEnginePid() and enginePid.test.ts's own afterEach cleanup. Confirmed live
 * this session: running `npm test` while a real dev engine was up repeatedly wiped its real pid
 * file out from under it, producing "No engine PID file" on the next `./argus stop`/`restart`
 * even though the engine was still genuinely running. Same override pattern as
 * crashLog.ts's ARGUS_CRASH_LOG_PATH - resolved fresh on every call (not cached at module load)
 * so a test can set the env var in beforeAll, after this module is already imported.
 */
export function resolveEnginePidPath(): string {
  const override = process.env.ARGUS_ENGINE_PID_PATH?.trim();
  return override || DEFAULT_ENGINE_PID_PATH;
}

export function ensureDataDir(): void {
  const dir = join(process.cwd(), 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function writeEnginePid(pid: number): void {
  ensureDataDir();
  writeFileSync(resolveEnginePidPath(), String(pid), 'utf8');
}

export function readEnginePid(): number | null {
  const path = resolveEnginePidPath();
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function clearEnginePid(): void {
  const path = resolveEnginePidPath();
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
