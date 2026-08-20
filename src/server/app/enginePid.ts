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

/** Returns true if pid file points to a live process (best-effort, cross-platform). */
export function isEngineProcessRunning(): boolean {
  const pid = readEnginePid();
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    clearEnginePid();
    return false;
  }
}
