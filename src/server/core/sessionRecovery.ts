/**
 * Persist a dirty/clean process marker so an OS bugcheck is visible on the next boot.
 * Does not auto-resume TRADING_ENABLED. Does not skip recon. Holds *entry* ideas until
 * a RECONCILIATION_MATCH after an interrupted session. Risk-exit SELL is not held here.
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { eventBus } from './EventBus';
import { EVENTS } from './eventNames';
import { structuredLogger } from '../observability/StructuredLogger';

export interface RuntimeSessionFile {
  pid: number;
  /** Real fix (2026-08-24 readiness audit, Part 11): the prior unexplained 16:20:51Z process
   *  death had no parent PID or exit-code evidence at all - only these two fields, both cheap and
   *  always available, close that specific gap for the NEXT unexplained death. Neither invents a
   *  root cause; they only ensure more evidence exists if one recurs. */
  parentPid: number | null;
  startedAt: string;
  lastHeartbeatAt: string;
  cleanShutdown: boolean;
  /** Set by the process.on('exit') handler below - null until the process actually exits, since a
   *  process cannot observe its own exit code before it happens. */
  exitCode: number | null;
  interruptedOnLoad?: boolean;
}

const DEFAULT_PATH = join(process.cwd(), 'data', '.argus_runtime_session.json');
let filePath = DEFAULT_PATH;
let holdNewEntryIdeas = false;
let started = false;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let current: RuntimeSessionFile | null = null;
let matchHandler: (() => void) | null = null;

export function setSessionRecoveryPathForTests(path: string): void {
  filePath = path;
}

export function resetSessionRecoveryForTests(): void {
  holdNewEntryIdeas = false;
  started = false;
  current = null;
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  if (matchHandler) {
    eventBus.unsubscribe(EVENTS.RECONCILIATION_MATCH, matchHandler);
    matchHandler = null;
  }
  filePath = DEFAULT_PATH;
}

function write(row: RuntimeSessionFile): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(row, null, 2), 'utf8');
}

function read(): RuntimeSessionFile | null {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as RuntimeSessionFile;
    if (!raw || typeof raw.cleanShutdown !== 'boolean') return null;
    return raw;
  } catch {
    return null;
  }
}

/** Call once at process start, before Autobot restore. */
export function loadInterruptedSessionMarker(): boolean {
  const prev = read();
  const interrupted = !!(prev && prev.cleanShutdown === false);
  holdNewEntryIdeas = interrupted;
  if (interrupted && prev) {
    console.warn('[sessionRecovery] Previous Argus session did not clean-shutdown. Holding new BUY ideas until RECONCILIATION_MATCH. Risk-exit SELL and recon still run. Not an auto-resume of a pause.');
    // Post-remediation-audit addition (Phase 5, crash forensics): the 2026-08-24 16:20:51Z death
    // left zero trace in crash.log, Windows Application/System event logs, or a graceful-shutdown
    // log line - the only evidence available at the NEXT boot was this same heartbeat file, read
    // by eye. Making that a real, queryable observability_events row (not just a console line) so
    // a future forensic pass can query "was the prior session's death ever cleanly explained"
    // without needing a human to have been watching the console at the time.
    const lastHeartbeatMs = Date.parse(prev.lastHeartbeatAt);
    structuredLogger.warn(
      `Previous Argus session (pid ${prev.pid}) did not shut down cleanly - last heartbeat ${prev.lastHeartbeatAt}, started ${prev.startedAt}. New BUY ideas held until reconciliation match.`,
      {
        category: 'TRADING_SAFETY',
        eventType: 'UNCLEAN_SHUTDOWN_DETECTED',
        component: 'sessionRecovery',
        previousPid: prev.pid,
        previousStartedAt: prev.startedAt,
        previousLastHeartbeatAt: prev.lastHeartbeatAt,
        msSincePreviousHeartbeat: Number.isFinite(lastHeartbeatMs) ? Date.now() - lastHeartbeatMs : null,
        currentPid: process.pid,
      },
    );
  }
  return interrupted;
}

export function allowsNewEntryIdeas(): boolean {
  return !holdNewEntryIdeas;
}

let exitHandlerInstalled = false;

export function beginRuntimeSession(): void {
  current = {
    pid: process.pid,
    parentPid: typeof process.ppid === 'number' ? process.ppid : null,
    startedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
    cleanShutdown: false,
    exitCode: null,
  };
  write(current);
  if (!heartbeat) {
    heartbeat = setInterval(() => {
      if (!current) return;
      // Only bump lastHeartbeatAt — avoid rewriting identical JSON if the clock
      // second hasn't moved enough to change the ISO string (still writes each tick;
      // Vite must ignore data/ so this never triggers SPA reload).
      current.lastHeartbeatAt = new Date().toISOString();
      try {
        write(current);
      } catch {
        /* fail-open heartbeat */
      }
    }, 15000);
    heartbeat.unref?.();
  }
  // Real fix (2026-08-24 readiness audit, Part 11): 'exit' is the one event Node guarantees fires
  // on every normal exit path (including an uncaught exception after globalErrorHandlers.ts's own
  // handling, and an explicit process.exit() call) - it cannot fire on SIGKILL/a hard OS-level
  // kill (nothing in-process can), so this still cannot explain the prior unexplained death, but it
  // closes the gap for every OTHER kind of exit this process might have going forward. Only
  // synchronous work is possible here (Node's own constraint on 'exit' handlers) - fs.writeFileSync
  // is safe, an async write would silently never complete.
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true;
    process.on('exit', (code) => {
      if (!current) return;
      current.exitCode = code;
      try { write(current); } catch { /* best-effort on the way out */ }
    });
  }
}

export function markCleanShutdown(): void {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  if (!current) {
    current = {
      pid: process.pid,
      parentPid: typeof process.ppid === 'number' ? process.ppid : null,
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      cleanShutdown: true,
      exitCode: null,
    };
  }
  current.cleanShutdown = true;
  current.lastHeartbeatAt = new Date().toISOString();
  try {
    write(current);
  } catch (e) {
    console.error('[sessionRecovery] Failed to persist clean shutdown marker', e);
  }
}

export function releaseEntryHoldAfterReconMatch(): void {
  if (!holdNewEntryIdeas) return;
  holdNewEntryIdeas = false;
  console.log('[sessionRecovery] RECONCILIATION_MATCH after interrupted session — new entry ideas allowed. tradingState unchanged (not a blind resume of PAUSED).');
}

export function startSessionRecoveryListeners(): void {
  if (started) return;
  started = true;
  matchHandler = () => {
    releaseEntryHoldAfterReconMatch();
  };
  eventBus.subscribe(EVENTS.RECONCILIATION_MATCH, matchHandler);
}

export function forceHoldNewEntryIdeasForTests(value: boolean): void {
  holdNewEntryIdeas = value;
}
