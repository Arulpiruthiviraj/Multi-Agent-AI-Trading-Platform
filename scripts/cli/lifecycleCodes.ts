/**
 * Stable, machine-readable result codes and exit codes for the CLI lifecycle commands (start / stop / restart / resume / pause / status), added 2026-10-15.
 * Pure data and pure functions: no network, no process table. The catalogue of what each code means, how to diagnose it and how to recover is in
 * docs/operations/ARGUS_CLI_LIFECYCLE_TROUBLESHOOTING.md (keep the two in sync; lifecycleCodes.docsync.test.ts enforces it).
 *
 * Pre-existing error reasons (ENGINE_UNREACHABLE, REQUEST_ABORTED_OR_TIMED_OUT, TRANSPORT_FAILED) come from fetchJson() and are reused, not renamed.
 */
export const LIFECYCLE_CODES = [
  // start
  'ENGINE_STARTED', 'ENGINE_ALREADY_RUNNING', 'ENGINE_ALREADY_RUNNING_UNTRACKED', 'ENGINE_BOOT_TIMEOUT', 'ENGINE_EXITED_DURING_BOOT', 'ENGINE_PROD_BUILD_MISSING',
  // stop
  'ENGINE_STOPPED', 'ENGINE_NOT_RUNNING', 'ENGINE_FORCE_TERMINATED', 'STOP_TIMEOUT_STILL_ANSWERING', 'STOP_REQUEST_FAILED', 'STOP_REFUSED_PID_NOT_ARGUS',
  // restart
  'RESTART_ABORTED_STOP_INCOMPLETE',
  // resume / pause
  'RESUME_REFUSED', 'RECONCILIATION_NOT_CLEAN', 'PAUSE_REFUSED',
  // transport (from fetchJson)
  'ENGINE_UNREACHABLE', 'REQUEST_ABORTED_OR_TIMED_OUT', 'TRANSPORT_FAILED',
] as const;
export type LifecycleCode = typeof LIFECYCLE_CODES[number];

/** Process exit codes. 0 = the requested end state holds. 1 = the command failed. 2 = INCONCLUSIVE: the process is alive but the requested transition did not complete (still booting / still draining / wedged). 3 = start succeeded but trading was deliberately left paused. */
export const EXIT = { OK: 0, FAILED: 1, INCONCLUSIVE: 2, PAUSED_BY_SAFETY: 3 } as const;

export interface LifecycleResult {
  ok: boolean;
  code: LifecycleCode;
  message: string;
  pid?: number | null;
  /** exit code the command should finish with */
  exitCode: number;
  graceful?: boolean;
  [extra: string]: unknown;
}

/** Lifecycle state as seen from the CLI. Vocabulary matches the existing engine/ecosystem states; PROCESS_ALIVE_NOT_ANSWERING is the honest name for "starting or wedged: cannot tell from outside". */
export type CliLifecycleState = 'STOPPED' | 'RUNNING' | 'PROCESS_ALIVE_NOT_ANSWERING' | 'UNKNOWN';

export function classifyLifecycleState(input: { answering: boolean; refused: boolean; pidFileAlive: boolean }): CliLifecycleState {
  if (input.answering) return 'RUNNING';
  if (input.pidFileAlive) return 'PROCESS_ALIVE_NOT_ANSWERING';
  if (input.refused) return 'STOPPED';
  return 'UNKNOWN';
}

/** Map a fetchJson() error message prefix to a lifecycle code (the codes already used there). */
export function transportCodeOf(message: string): LifecycleCode | null {
  for (const c of ['ENGINE_UNREACHABLE', 'REQUEST_ABORTED_OR_TIMED_OUT', 'TRANSPORT_FAILED'] as const) if (message.startsWith(c)) return c;
  return null;
}

export const DEFAULT_STOP_TIMEOUT_MS = 30_000;
