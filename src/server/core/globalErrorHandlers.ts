/**
 * Global process error handlers — log to crash.log, emit SYSTEM_ANOMALY, keep running unless fatal.
 * Wired early in server.ts boot. Does not bypass RiskEngine/OMS.
 */
import { appendCrashLog, isFatalProcessError } from './crashLog';
import { eventBus } from './EventBus';
import { EVENTS } from './eventNames';

export { isFatalProcessError } from './crashLog';

function formatDetail(reason: unknown): string {
  return reason instanceof Error ? (reason.stack || reason.message) : String(reason);
}

export function handleUncaughtException(err: unknown): void {
  const detail = formatDetail(err);
  appendCrashLog('uncaughtException', detail);
  console.error('[GlobalErrorHandlers] uncaughtException:', detail);
  try {
    eventBus.emit(EVENTS.SYSTEM_ANOMALY, {
      kind: 'uncaughtException',
      message: detail,
      fatal: isFatalProcessError(err),
      at: new Date().toISOString(),
    });
  } catch {
    /* EventBus may not be ready on very early boot */
  }
  if (isFatalProcessError(err)) {
    console.error('[GlobalErrorHandlers] Fatal error — exiting.');
    process.exit(1);
  }
}

export function handleUnhandledRejection(reason: unknown): void {
  const detail = formatDetail(reason);
  appendCrashLog('unhandledRejection', detail);
  console.error('[GlobalErrorHandlers] unhandledRejection:', detail);
  try {
    eventBus.emit(EVENTS.SYSTEM_ANOMALY, {
      kind: 'unhandledRejection',
      message: detail,
      fatal: isFatalProcessError(reason),
      at: new Date().toISOString(),
    });
  } catch {
    /* EventBus may not be ready on very early boot */
  }
  if (isFatalProcessError(reason)) {
    console.error('[GlobalErrorHandlers] Fatal rejection — exiting.');
    process.exit(1);
  }
}

let installed = false;

export function installGlobalErrorHandlers(): void {
  if (installed) return;
  installed = true;
  process.on('uncaughtException', handleUncaughtException);
  process.on('unhandledRejection', handleUnhandledRejection);
}
