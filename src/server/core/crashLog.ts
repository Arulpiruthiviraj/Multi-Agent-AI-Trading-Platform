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
    console.error('[crashLog] Failed to write crash.log', e);
  }
}

export function isFatalProcessError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${err.stack ?? ''}` : String(err);
  return /SQLITE_CORRUPT|database disk image is malformed|FATAL.*memory|heap out of memory/i.test(msg);
}
