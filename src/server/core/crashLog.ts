/**
 * Append-only crash/anomaly log under data/logs/crash.log (never throws to caller).
 */
import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'data', 'logs');
const DEFAULT_LOG_FILE = path.join(LOG_DIR, 'crash.log');

function resolveLogFile(): string {
  const override = process.env.ARGUS_CRASH_LOG_PATH?.trim();
  return override || DEFAULT_LOG_FILE;
}

export function appendCrashLog(label: string, detail: string): void {
  try {
    const logFile = resolveLogFile();
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const line = `[${new Date().toISOString()}] ${label}\n${detail}\n---\n`;
    fs.appendFileSync(logFile, line, 'utf8');
  } catch (e) {
    // Never call console.error here. This is the durable fallback sink itself - during the real
    // 2026-08-26 incident, console.error's own write path (a broken stdout/stderr SyncWriteStream)
    // was exactly what cascaded into a fatal, self-re-triggering exception. A raw write to the
    // real stderr fd doesn't depend on whatever just broke the normal console/logger path.
    try {
      fs.writeSync(2, `[crashLog] Failed to write crash.log: ${e instanceof Error ? e.message : String(e)}\n`);
    } catch {
      /* Truly nowhere left to write. Give up silently rather than throw again. */
    }
  }
}

export function isFatalProcessError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${err.stack ?? ''}` : String(err);
  return /SQLITE_CORRUPT|database disk image is malformed|FATAL.*memory|heap out of memory/i.test(msg);
}
