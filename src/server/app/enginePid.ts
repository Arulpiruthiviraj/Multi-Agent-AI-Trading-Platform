/**
 * Process PID file for CLI-managed headless engine instances.
 * Single-process constraint: one Argus engine per data/argus.db.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
