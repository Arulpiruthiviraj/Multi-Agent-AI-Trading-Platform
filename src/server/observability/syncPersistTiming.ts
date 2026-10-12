/**
 * Warn-level timing instrumentation around synchronous persist points (2026-10-12, pre-market
 * perfection mission item 1, event-loop stall forensic).
 *
 * Forensic context: persistAssessment p95 measured 1,369ms - every one of these commits runs
 * synchronously on the main thread (better-sqlite3), so a disk-level stall turns a routine
 * persist into an event-loop stall that freezes /health. The instrumented call sites:
 *   - RiskEngine.persistAssessment (risk_assessments + risk_gate_results transaction)
 *   - decisionProvenance.persistDecisionProvenance (decision_provenance single-row INSERT)
 *   - ObservabilityStore.defaultPersist (observability_events batch flush)
 *
 * Contract: log at WARN (SYNC_PERSIST_SLOW) when a single persist's main-thread block reaches
 * syncPersistWarnMs (config/observability.json, deliberately below the measured p95 - this is
 * evidence collection, not an alarm). Fail-open: never throws, never gates, never changes the
 * wrapped call's return value or timing semantics beyond the nanosecond clock reads.
 */
import { observabilityConfig } from '../config/observability';
import { observeSafe, structuredLogger } from './StructuredLogger';

/** Logs at WARN when a single synchronous persist blocked the event loop past the config threshold. */
export function checkSyncPersistDuration(callSite: string, durationMs: number): void {
  const thresholdMs = observabilityConfig.syncPersistWarnMs;
  if (!(durationMs >= thresholdMs)) return;
  observeSafe(
    () =>
      structuredLogger.warn('sync_persist_slow', {
        category: 'SYSTEM',
        eventType: 'SYNC_PERSIST_SLOW',
        callSite,
        durationMs: Math.round(durationMs * 10) / 10,
        thresholdMs,
        reasoning:
          `Synchronous persist at ${callSite} blocked the event loop for ` +
          `${Math.round(durationMs)}ms (>= ${thresholdMs}ms warn threshold). ` +
          `Forensic context (2026-10-12): persistAssessment p95 was 1,369ms; a disk-level stall ` +
          `at a commit like this can stretch to minutes and freeze /health.`,
      }),
    'syncPersistTiming',
  );
}

function elapsedMsSince(startNs: bigint): number {
  return Number(process.hrtime.bigint() - startNs) / 1e6;
}

/** Times a synchronous persist; returns fn()'s value unchanged. Warns (never throws) when slow. */
export function timeSyncPersist<T>(callSite: string, fn: () => T): T {
  const startNs = process.hrtime.bigint();
  try {
    return fn();
  } finally {
    try {
      checkSyncPersistDuration(callSite, elapsedMsSince(startNs));
    } catch {
      /* fail-open: instrumentation must never break the persist it measures */
    }
  }
}

/**
 * Times an async persist whose underlying work is synchronous better-sqlite3 (e.g.
 * ObservabilityStore.defaultPersist's drizzle batch insert). The awaited window IS the
 * main-thread block, so measuring it is the same measurement as timeSyncPersist.
 */
export async function timeAsyncPersist<T>(callSite: string, fn: () => Promise<T>): Promise<T> {
  const startNs = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    try {
      checkSyncPersistDuration(callSite, elapsedMsSince(startNs));
    } catch {
      /* fail-open */
    }
  }
}
