/**
 * Global process error handlers — log to crash.log, emit SYSTEM_ANOMALY, keep running unless fatal.
 * Wired early in server.ts boot. Does not bypass RiskEngine/OMS.
 *
 * Hardened after the 2026-08-26 incident: the handler's own console.error() call threw (a broken
 * stdout/stderr SyncWriteStream — ServerLogBuffer.ts's wrapConsole calls the real, unwrapped
 * console.error internally), which re-entered these same handlers and cascaded into a fatal,
 * unrecoverable process death. Every side-effecting call below is now individually exception-safe
 * with a fallback chain (structured console -> raw fd write -> give up silently), and a storm
 * circuit-breaker exits cleanly instead of risking an unbounded cascade if process-level errors
 * ever start firing in a tight burst again (see crash.log forensics from that incident).
 */
import fs from 'fs';
import { appendCrashLog, isFatalProcessError } from './crashLog';
import { eventBus } from './EventBus';
import { EVENTS } from './eventNames';

export { isFatalProcessError } from './crashLog';

function formatDetail(reason: unknown): string {
  return reason instanceof Error ? (reason.stack || reason.message) : String(reason);
}

// If the handler itself fires this many times within this window, something is actively and
// repeatedly breaking (an IO subsystem, a broken write stream, etc.) rather than one isolated
// error — exit deliberately and cleanly instead of continuing in an unknown degraded state (or
// risking the exact recursive-throw cascade this hardening pass fixes). Isolated errors minutes
// apart — the normal case — never approach this.
const STORM_WINDOW_MS = 5000;
const STORM_THRESHOLD = 4;
let recentHandlerHits: number[] = [];

function recordHandlerHitAndCheckStorm(): boolean {
  const now = Date.now();
  recentHandlerHits.push(now);
  recentHandlerHits = recentHandlerHits.filter((t) => now - t <= STORM_WINDOW_MS);
  return recentHandlerHits.length > STORM_THRESHOLD;
}

/**
 * Never throws. Tries the normal console path first; if that fails (the exact failure mode from
 * the 2026-08-26 incident), falls back to a raw write on the real stderr fd, which does not go
 * through ServerLogBuffer's console wrapper or depend on whatever just broke it. If even that
 * fails, gives up silently rather than let the error escape and re-trigger this same handler.
 */
function safeEmergencyLog(label: string, detail: string): void {
  try {
    console.error(`[GlobalErrorHandlers] ${label}:`, detail);
    return;
  } catch {
    /* console.error's own write path is exactly what can be broken - fall through. */
  }
  try {
    fs.writeSync(2, `[GlobalErrorHandlers] ${label} (emergency path): ${detail}\n`);
  } catch {
    /* Truly nowhere left to write. Give up silently rather than throw again. */
  }
}

function safeAppendCrashLog(label: string, detail: string): void {
  try {
    appendCrashLog(label, detail);
  } catch {
    /* appendCrashLog already swallows its own errors; this guard is defense-in-depth only. */
  }
}

function safeEmitAnomaly(kind: string, message: string, fatal: boolean): void {
  try {
    eventBus.emit(EVENTS.SYSTEM_ANOMALY, { kind, message, fatal, at: new Date().toISOString() });
  } catch {
    /* EventBus may not be ready on very early boot, or may itself be part of a broader failure. */
  }
}

function handleProcessError(kind: 'uncaughtException' | 'unhandledRejection', err: unknown): void {
  const detail = formatDetail(err);
  const storming = recordHandlerHitAndCheckStorm();

  // Durable sink first (crash.log has proven itself independent of a broken stdout stream this
  // exact way before); only then attempt the console path, which is the one that can be broken by
  // the very error being handled.
  safeAppendCrashLog(kind, detail);
  safeEmergencyLog(kind, detail);
  safeEmitAnomaly(kind, detail, isFatalProcessError(err));

  if (storming) {
    safeAppendCrashLog(kind, `Error storm detected (>${STORM_THRESHOLD} in ${STORM_WINDOW_MS}ms) — exiting cleanly instead of risking an unbounded cascade.`);
    process.exit(1);
    return;
  }

  if (isFatalProcessError(err)) {
    safeAppendCrashLog(kind, 'Fatal error — exiting.');
    process.exit(1);
  }
}

export function handleUncaughtException(err: unknown): void {
  handleProcessError('uncaughtException', err);
}

export function handleUnhandledRejection(reason: unknown): void {
  handleProcessError('unhandledRejection', reason);
}

let installed = false;

export function installGlobalErrorHandlers(): void {
  if (installed) return;
  installed = true;
  process.on('uncaughtException', handleUncaughtException);
  process.on('unhandledRejection', handleUnhandledRejection);
}

/** Test-only: reset the storm circuit-breaker's window between test cases. */
export function resetErrorStormStateForTests(): void {
  recentHandlerHits = [];
}
