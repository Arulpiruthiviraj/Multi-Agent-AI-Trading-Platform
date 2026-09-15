/**
 * Trading/research-plane isolation (2026-09-14, item #25 / mandate Phase 2). See
 * config/observability.json's own comment for the full rationale and incident context.
 *
 * Two real protections around the heaviest read-only observability reports:
 *   1. Serialized - only one heavy report may run at a time. A second concurrent attempt is
 *      refused immediately (never queued - queueing would still let requests pile up in memory,
 *      just later).
 *   2. Memory circuit breaker - refuses to even start while RSS is already at/above
 *      memoryTelemetryWarningRssMb (reused, not duplicated). This is the exact precondition
 *      observed during the incident this guard exists to prevent a repeat of.
 *
 * HONESTY: heavyReportTimeoutMs bounds how long a CALLER waits, not the underlying work itself -
 * Node cannot forcibly cancel synchronous better-sqlite3 calls already in flight. The mutex is
 * therefore held until the real underlying promise settles, not until the race's timeout branch
 * fires - a caller can get a timeout error while the report keeps running and still correctly
 * blocks a second heavy report from starting in the meantime.
 */
import { observabilityConfig } from '../config/observability';
import { structuredLogger, observeSafe } from './StructuredLogger';

export type HeavyReportRefusalCode = 'CONCURRENT_HEAVY_REPORT' | 'MEMORY_ELEVATED' | 'TIMEOUT';

export class HeavyReportRefusedError extends Error {
  constructor(public readonly code: HeavyReportRefusalCode, message: string) {
    super(message);
    this.name = 'HeavyReportRefusedError';
  }
}

let currentlyRunning: string | null = null;
const defaultRssReader = (): number => process.memoryUsage().rss / (1024 * 1024);
let rssReader: () => number = defaultRssReader;

export function isHeavyReportInProgress(): boolean {
  return currentlyRunning !== null;
}

/** Real current process RSS in MB - indirected through a swappable reader (not vi.spyOn on this
 *  module's own export, which cannot intercept guardHeavyReport()'s same-file internal call to
 *  this function) so tests can stub it deterministically. Same idiom as
 *  sessionRecovery.ts's setSessionRecoveryPathForTests(). */
export function currentRssMb(): number {
  return rssReader();
}

export function setRssReaderForTests(fn: () => number): void {
  rssReader = fn;
}

/** Test-only reset. */
export function resetHeavyReportGuardForTests(): void {
  currentlyRunning = null;
  rssReader = defaultRssReader;
}

export async function guardHeavyReport<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (currentlyRunning) {
    const message = `Refused: '${name}' cannot run while '${currentlyRunning}' is already in progress - `
      + 'heavy research reports are serialized to protect the trading process.';
    observeSafe(() => structuredLogger.warn(message, { category: 'SYSTEM', eventType: 'HEAVY_REPORT_REFUSED', name, code: 'CONCURRENT_HEAVY_REPORT' }));
    throw new HeavyReportRefusedError('CONCURRENT_HEAVY_REPORT', message);
  }

  const rssMb = currentRssMb();
  if (rssMb >= observabilityConfig.memoryTelemetryWarningRssMb) {
    const message = `Refused: process memory already elevated (${rssMb.toFixed(0)}MB, at/above the `
      + `${observabilityConfig.memoryTelemetryWarningRssMb}MB warning threshold) - heavy research `
      + 'reports are disabled until memory recovers.';
    observeSafe(() => structuredLogger.warn(message, { category: 'SYSTEM', eventType: 'HEAVY_REPORT_REFUSED', name, code: 'MEMORY_ELEVATED', rssMb }));
    throw new HeavyReportRefusedError('MEMORY_ELEVATED', message);
  }

  currentlyRunning = name;
  const startedAt = Date.now();
  observeSafe(() => structuredLogger.info(`Heavy report started: ${name}`, { category: 'SYSTEM', eventType: 'HEAVY_REPORT_STARTED', name }));

  // The REAL underlying work - its own settlement (not the race below) is what releases the mutex,
  // honestly reflecting that a timeout only releases the CALLER, never the in-flight work itself.
  const underlying = fn().finally(() => {
    currentlyRunning = null;
  });
  // A timeout-losing underlying promise must still have a rejection handler somewhere, or its
  // eventual failure becomes an unhandled rejection once the race below has already resolved.
  underlying.catch(() => { /* already surfaced via the race's own rejection path, or ignored on timeout */ });

  const timeoutMs = observabilityConfig.heavyReportTimeoutMs;
  try {
    const result = await Promise.race([
      underlying,
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => {
          const message = `'${name}' exceeded its ${timeoutMs}ms budget - the underlying query may still be `
            + 'running (Node cannot forcibly cancel synchronous SQLite work in flight), but the caller has been released.';
          observeSafe(() => structuredLogger.warn(message, { category: 'SYSTEM', eventType: 'HEAVY_REPORT_REFUSED', name, code: 'TIMEOUT', timeoutMs }));
          reject(new HeavyReportRefusedError('TIMEOUT', message));
        }, timeoutMs);
        t.unref?.();
      }),
    ]);
    const durationMs = Date.now() - startedAt;
    observeSafe(() => structuredLogger.info(`Heavy report completed: ${name} in ${durationMs}ms`, { category: 'SYSTEM', eventType: 'HEAVY_REPORT_COMPLETED', name, durationMs }));
    return result;
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    const message = e instanceof Error ? e.message : String(e);
    if (!(e instanceof HeavyReportRefusedError)) {
      // A real failure inside fn() itself (not a guard refusal) - log it distinctly so
      // HEAVY_REPORT_REFUSED stays reserved for this module's own refusals.
      observeSafe(() => structuredLogger.error(`Heavy report failed: ${name} after ${durationMs}ms: ${message}`, { category: 'SYSTEM', eventType: 'HEAVY_REPORT_FAILED', name, durationMs, error: message }));
    }
    throw e;
  }
}
