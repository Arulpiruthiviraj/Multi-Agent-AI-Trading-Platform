/**
 * Maintenance-state contract for the external liveness watchdog (defect #3 hardening,
 * 2026-10-08).
 *
 * WHY THIS FILE EXISTS: the watchdog used to treat ANY stale heartbeat + unresponsive /ready +
 * live PID as a genuinely frozen process. But known, legitimate, event-loop-blocking maintenance
 * produces exactly the same observable signature: a multi-GB DB backup on the event loop, the
 * V8 heap-snapshot capture (documented live kill on 2026-09-14, see
 * docs/architecture/ARGUS_ARCHITECTURE.md P1-B), or a slow graceful drain. The watchdog
 * force-killed the engine mid-maintenance, the restart re-ran the same maintenance, and each
 * restart made things worse - a restart storm. This module lets the watchdog distinguish
 * "heartbeat stale because of known maintenance" from "process genuinely dead".
 *
 * THE CONTRACT (shared file, written by engine maintenance owners, read by the watchdog):
 *   path: data/.argus_maintenance_state.json (override: ARGUS_MAINTENANCE_STATE_PATH)
 *   {
 *     "updatedAt": "<ISO-8601, refreshed frequently while maintenance is active>",
 *     "backup": { "state": "IDLE|RUNNING|SUCCEEDED|FAILED|SKIPPED_DISK", "startedAt": "<ISO>" },
 *     "startupInProgress": false,
 *     "shutdownInProgress": false
 *   }
 *
 * OWNERSHIP: the `backup` section is owned by the backup workstream (DbBackupService) - its
 * state transitions (IDLE/RUNNING/SUCCEEDED/FAILED/SKIPPED_DISK) live there, NOT here; this
 * module only reads. `src/server/core/maintenanceState.ts` is the shared best-effort writer
 * any engine subsystem can use. `shutdownInProgress` is published by gracefulShutdown.ts at
 * drain start. The watchdog ALSO derives "startup in progress" independently from the runtime
 * session file's `startedAt` (no engine write needed for that).
 *
 * TRUST RULES (fail closed - when in doubt, do NOT defer; deferral is a privilege):
 * - Missing/unreadable/malformed file -> NO maintenance signal (escalate normally).
 * - `updatedAt` older than maintenanceFreshnessMs -> UNTRUSTED, treated as no signal. A dead
 *   publisher must never pin the watchdog in permanent deferral.
 * - Deferral itself is time-bounded by maintenanceDeferralMaxMs in the state machine: even a
 *   fresh, legitimate signal cannot defer judgment forever (a wedged backup is a real problem).
 */
import { existsSync, readFileSync } from 'node:fs';

export type BackupMaintenanceState = 'IDLE' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED_DISK';

export interface MaintenanceStateFile {
  updatedAt?: string;
  backup?: { state?: BackupMaintenanceState; startedAt?: string };
  heapSnapshot?: { state?: 'RUNNING' | 'SUCCEEDED' | 'FAILED'; startedAt?: string };
  startupInProgress?: boolean;
  shutdownInProgress?: boolean;
}

export interface MaintenanceSignal {
  /** Human label for logs, e.g. "backup:RUNNING" or "startup+shutdown". */
  kind: string;
  /** ms since updatedAt - how fresh the publisher's claim is. */
  signalAgeMs: number;
}

const VALID_BACKUP_STATES: ReadonlySet<string> = new Set([
  'IDLE',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'SKIPPED_DISK',
]);

/**
 * Pure evaluation of a parsed maintenance file. Returns a signal only when the file carries a
 * fresh, explicit "maintenance is actively running" claim; returns null for everything else
 * (missing fields, no active maintenance, stale publisher). Never throws.
 */
export function evaluateMaintenanceSignal(
  raw: unknown,
  nowMs: number,
  freshnessMs: number,
): MaintenanceSignal | null {
  if (!raw || typeof raw !== 'object') return null;
  const file = raw as MaintenanceStateFile;

  const updatedAtMs = typeof file.updatedAt === 'string' ? Date.parse(file.updatedAt) : NaN;
  if (!Number.isFinite(updatedAtMs)) return null;
  const signalAgeMs = nowMs - updatedAtMs;
  // updatedAt in the future is a broken clock, not fresh evidence - treat as untrusted.
  if (signalAgeMs < 0 || signalAgeMs > freshnessMs) return null;

  const kinds: string[] = [];
  const backupState = file.backup?.state;
  if (typeof backupState === 'string' && VALID_BACKUP_STATES.has(backupState)) {
    if (backupState === 'RUNNING') kinds.push('backup:RUNNING');
  } else if (backupState !== undefined) {
    // Unknown state string from a newer publisher - ignore the field, do not invent meaning.
  }
  // 2026-10-08 defect hunt (P1-W1): a V8 heap snapshot blocks the event loop for minutes;
  // without this the watchdog reads it as a frozen process and force-kills mid-snapshot.
  const heapState = file.heapSnapshot?.state;
  if (heapState === 'RUNNING') kinds.push('heapSnapshot:RUNNING');
  if (file.startupInProgress === true) kinds.push('startup');
  if (file.shutdownInProgress === true) kinds.push('shutdown');

  if (kinds.length === 0) return null;
  return { kind: kinds.join('+'), signalAgeMs };
}

/** I/O wrapper: reads and evaluates the maintenance file. Null on any read/parse failure. */
export function readMaintenanceSignal(
  filePath: string,
  nowMs: number,
  freshnessMs: number,
): MaintenanceSignal | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    return evaluateMaintenanceSignal(raw, nowMs, freshnessMs);
  } catch {
    return null;
  }
}
