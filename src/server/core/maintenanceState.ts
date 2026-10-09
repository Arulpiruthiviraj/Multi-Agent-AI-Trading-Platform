/**
 * Shared best-effort publisher for the engine maintenance-state file the external liveness
 * watchdog reads (see scripts/lib/watchdogMaintenanceState.ts for the full contract).
 *
 * 2026-10-08 defect #3 hardening: the watchdog can only defer judgment for known maintenance if
 * the engine actually tells it maintenance is happening. This module is the single choke point
 * for those writes - backup, shutdown, or any future maintenance owner calls
 * publishMaintenanceState() with a partial patch, which is merged over the last known file
 * contents and published atomically (tmp + rename, same pattern as sessionRecovery.ts).
 *
 * OWNERSHIP NOTE: this module owns the WRITE path only. The backup workstream owns the backup
 * state transitions (IDLE/RUNNING/SUCCEEDED/FAILED/SKIPPED_DISK) - it may call this publisher
 * or write the file itself; either way the schema must match the contract above. Do not grow a
 * second, parallel maintenance file here.
 *
 * Best-effort by design: a failure to publish maintenance state must never crash or block the
 * real maintenance work - it only means the watchdog loses one signal and falls back to its
 * conservative (non-deferring) escalation path.
 */
import { writeFileSync, readFileSync, mkdirSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertNotProductionRuntimePath } from './productionRuntimePathGuard';

export interface MaintenanceStatePatch {
  backup?: { state: 'IDLE' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED_DISK'; startedAt?: string };
  // 2026-10-08 defect hunt (P1-W1): v8.writeHeapSnapshot() is a synchronous, event-loop-blocking
  // V8 heap walk; a multi-minute snapshot looks exactly like a frozen process to the watchdog.
  // captureHeapSnapshot() publishes RUNNING around the walk so the watchdog defers judgment.
  heapSnapshot?: { state: 'RUNNING' | 'SUCCEEDED' | 'FAILED'; startedAt?: string };
  startupInProgress?: boolean;
  shutdownInProgress?: boolean;
}

const DEFAULT_PATH = join(process.cwd(), 'data', '.argus_maintenance_state.json');
let filePath = DEFAULT_PATH;

function resolvePath(): string {
  const override = process.env.ARGUS_MAINTENANCE_STATE_PATH?.trim();
  const resolved = override || filePath;
  assertNotProductionRuntimePath(resolved, 'maintenance state file', DEFAULT_PATH);
  return resolved;
}

/** Test-only: redirect the publish target. */
export function setMaintenanceStatePathForTests(path: string): void {
  filePath = path;
}

/** Test-only. */
export function resetMaintenanceStateForTests(): void {
  filePath = DEFAULT_PATH;
}

/**
 * Merge `patch` over the current file (if any) and publish atomically. Always refreshes
 * `updatedAt`. Never throws - returns false if the publish failed (watchdog then sees a stale
 * or missing file and correctly treats it as "no trusted maintenance signal").
 */
export function publishMaintenanceState(patch: MaintenanceStatePatch): boolean {
  try {
    const path = resolvePath();
    let current: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (parsed && typeof parsed === 'object') current = parsed as Record<string, unknown>;
      } catch {
        /* corrupt file - overwrite with the fresh patch rather than merging garbage */
      }
    }
    const merged = { ...current, ...patch, updatedAt: new Date().toISOString() };
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(merged, null, 2), 'utf8');
      renameSync(temporary, path);
    } finally {
      try { unlinkSync(temporary); } catch { /* renamed or absent */ }
    }
    return true;
  } catch {
    return false;
  }
}
