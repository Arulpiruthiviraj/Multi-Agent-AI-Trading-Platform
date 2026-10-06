/**
 * In-process honest counters. Never inferred from UI. Reset only in tests.
 */
import { observabilityConfig } from '../config/observability';

export type MetricName =
  | 'events_emitted'
  | 'events_persisted'
  | 'events_dropped_queue_full'
  | 'events_persist_failed'
  | 'logs_emitted'
  | 'logs_redacted'
  | 'market_data_seen'
  | 'market_data_sampled'
  | 'decisions_seen'
  | 'orders_submitted'
  | 'orders_filled'
  | 'orders_unknown'
  | 'fills_recorded'
  | 'fills_duplicate'
  | 'risk_assessments'
  | 'kill_switch'
  | 'reconciliation_mismatch'
  | 'logger_errors';

const counters = new Map<MetricName, number>();

export function incMetric(name: MetricName, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

/**
 * 2026-10-06 (October 5 forensic follow-up, Phase 2 - observability self-health). Real gap this
 * closes: `logger_errors` (above) was already a real, correct cumulative counter, but a raw total
 * alone cannot answer "is this broken RIGHT NOW" - the cycleId TDZ bug (fixed in
 * OpportunityDiscovery.ts the same day) demonstrated exactly this: observeSafe() correctly kept
 * production running while one specific event path silently failed on every single cycle for
 * hours, and nothing distinguished that from ordinary, rare, already-recovered noise.
 *
 * Deliberately tracked PER TAG, not as one global success/failure pair: a naive global signal
 * would have been worthless for exactly the cycleId case, since other, unrelated observeSafe()
 * calls (the pre-existing snapshot/swap-outcome events) kept succeeding in the very same cycle the
 * broken one failed in - a global "last success" timestamp would have looked healthy the whole
 * time. `tag` is an explicit, caller-supplied label (the event's own eventType string) passed to
 * observeSafe(fn, tag) - not every one of this codebase's ~44 observeSafe() call sites has been
 * updated to pass one (that is a larger, separate sweep, out of scope here); untagged calls share
 * the 'UNTAGGED' bucket, which still carries a real but coarser signal.
 *
 * Fail-open observability itself is unchanged - this never affects observeSafe()'s own
 * swallow-and-continue behavior. It only makes a swallowed failure's recency/nature visible.
 */
export interface TagHealth {
  tag: string;
  failureCount: number;
  lastFailureAt: string | null;
  lastFailureType: string | null;
  lastSuccessAt: string | null;
  /** True when at least one failure has occurred AND no success has been recorded since for THIS
   *  tag - the exact "silently broken right now" state the cycleId bug produced. A failure
   *  followed by a later success for the SAME tag is NOT degraded. */
  degraded: boolean;
}

interface TagHealthState {
  failureCount: number;
  lastFailureAtMs: number | null;
  lastFailureType: string | null;
  lastSuccessAtMs: number | null;
}

const tagHealth = new Map<string, TagHealthState>();

function getOrInitTagHealth(tag: string): TagHealthState {
  let state = tagHealth.get(tag);
  if (!state) {
    state = { failureCount: 0, lastFailureAtMs: null, lastFailureType: null, lastSuccessAtMs: null };
    tagHealth.set(tag, state);
  }
  return state;
}

/** Called from observeSafe()'s own catch block and logStructured()'s own catch block - the two
 *  real sites a swallowed observability failure can occur. `errorType` is the error's own `.name`
 *  (e.g. 'ReferenceError') when available, falling back to 'UNKNOWN_ERROR'. */
export function recordObservabilityFailure(tag: string, errorType: string): void {
  const state = getOrInitTagHealth(tag);
  state.failureCount += 1;
  state.lastFailureAtMs = Date.now();
  state.lastFailureType = errorType;
}

/** Called on every observeSafe() callback that completes without throwing, and every successful
 *  logStructured() completion - the real "this specific path is alive" signal, independent of the
 *  cumulative logs_emitted counter (which keeps growing even if ONE path's emission silently
 *  stopped while every other path kept going). */
export function recordObservabilitySuccess(tag: string): void {
  getOrInitTagHealth(tag).lastSuccessAtMs = Date.now();
}

function toTagHealth(tag: string, state: TagHealthState): TagHealth {
  const degraded = state.lastFailureAtMs != null
    && (state.lastSuccessAtMs == null || state.lastSuccessAtMs < state.lastFailureAtMs);
  return {
    tag,
    failureCount: state.failureCount,
    lastFailureAt: state.lastFailureAtMs != null ? new Date(state.lastFailureAtMs).toISOString() : null,
    lastFailureType: state.lastFailureType,
    lastSuccessAt: state.lastSuccessAtMs != null ? new Date(state.lastSuccessAtMs).toISOString() : null,
    degraded,
  };
}

/** Per-tag breakdown for every tag that has seen at least one call (success or failure). */
export function listObservabilityHealth(): TagHealth[] {
  return [...tagHealth.entries()].map(([tag, state]) => toTagHealth(tag, state));
}

export function getObservabilityHealthForTag(tag: string): TagHealth {
  return toTagHealth(tag, getOrInitTagHealth(tag));
}

/** True if ANY tracked tag is currently degraded - the single top-level health-check boolean. */
export function isAnyObservabilityTagDegraded(): boolean {
  return [...tagHealth.values()].some((state) =>
    state.lastFailureAtMs != null && (state.lastSuccessAtMs == null || state.lastSuccessAtMs < state.lastFailureAtMs));
}

export function resetObservabilityHealthForTests(): void {
  tagHealth.clear();
}

export function getMetric(name: MetricName): number {
  return counters.get(name) ?? 0;
}

export function snapshotMetrics(): Record<MetricName, number> {
  const names: MetricName[] = [
    'events_emitted', 'events_persisted', 'events_dropped_queue_full', 'events_persist_failed',
    'logs_emitted', 'logs_redacted', 'market_data_seen', 'market_data_sampled',
    'decisions_seen', 'orders_submitted', 'orders_filled', 'orders_unknown',
    'fills_recorded', 'fills_duplicate', 'risk_assessments', 'kill_switch',
    'reconciliation_mismatch', 'logger_errors',
  ];
  const out = {} as Record<MetricName, number>;
  for (const n of names) out[n] = counters.get(n) ?? 0;
  return out;
}

export interface ProcessTelemetrySample {
  ts: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  /** Mean event-loop delay over this sampling window - kept for backward compatibility with
   *  existing readers; see eventLoopDelayP50/P95/P99/MaxMs below (added 2026-09-14 overnight
   *  remediation, mandate section 11/28) for the fuller, equally cheap picture. A single mean can
   *  hide a real tail-latency problem (e.g. mostly-fast with rare multi-second stalls averaging
   *  out to a small mean) - percentiles/max come from the SAME already-running
   *  monitorEventLoopDelay() histogram (Node's own C++ implementation already tracks them; reading
   *  a few more properties off the same object costs nothing extra). */
  eventLoopDelayMs: number | null;
  eventLoopDelayP50Ms: number | null;
  eventLoopDelayP95Ms: number | null;
  eventLoopDelayP99Ms: number | null;
  eventLoopDelayMaxMs: number | null;
  soakEvidence: 'CALENDAR_EVIDENCE_REQUIRED';
}

const processSamples: ProcessTelemetrySample[] = [];

export function resetMetricsForTests(): void {
  counters.clear();
  processSamples.length = 0;
  reflectionEngineCycleSamples.length = 0;
  reflectionEngineSkippedOverlapCount = 0;
}

export function recordProcessTelemetrySample(sample: Omit<ProcessTelemetrySample, 'soakEvidence'>): void {
  try {
    const cap = observabilityConfig.processTelemetryRingSize;
    processSamples.push({ ...sample, soakEvidence: 'CALENDAR_EVIDENCE_REQUIRED' });
    while (processSamples.length > cap) processSamples.shift();
  } catch {
    /* fail-open */
  }
}

export function getProcessTelemetrySamples(): readonly ProcessTelemetrySample[] {
  return processSamples;
}

/**
 * P1-A follow-up (2026-09-23): runtime PROOF, not just inference, that ReflectionEngine.ts's
 * already-committed `inFlight` re-entrancy guard is doing real work, plus visibility into per-cycle
 * cost of its 3 full-table scans (trades / agent_predictions / kronos_predictions). Same bounded
 * ring-buffer pattern as processSamples above - in-memory only, capped at
 * observabilityConfig.reflectionEngineMetricsRingSize, deliberately NOT a new DB table (the whole
 * point is not to recreate the unbounded-growth shape this instrumentation exists to verify was
 * fixed). Written by ReflectionEngine.evaluateAgents() itself; read by
 * reflectionEngineHealthReport.ts. Does not change evaluateAgents()'s own control flow or the
 * inFlight guard's logic - purely additive measurement around it.
 */
export interface ReflectionEngineCycleSample {
  ts: number;
  cycleDurationMs: number;
  tradesRowsScanned: number;
  tradesQueryDurationMs: number;
  agentPredictionsRowsScanned: number;
  agentPredictionsQueryDurationMs: number;
  kronosPredictionsRowsScanned: number;
  kronosPredictionsQueryDurationMs: number;
}

const reflectionEngineCycleSamples: ReflectionEngineCycleSample[] = [];
/** Total count, since process start, of a would-be-overlapping evaluateAgents() cycle actually
 *  being prevented by the inFlight guard - the single most direct proof the guard is live, not
 *  dead code. Incremented at the guard's existing early-return site only; never touches the guard
 *  itself. */
let reflectionEngineSkippedOverlapCount = 0;

export function recordReflectionEngineCycleSample(sample: ReflectionEngineCycleSample): void {
  try {
    const cap = observabilityConfig.reflectionEngineMetricsRingSize;
    reflectionEngineCycleSamples.push(sample);
    while (reflectionEngineCycleSamples.length > cap) reflectionEngineCycleSamples.shift();
  } catch {
    /* fail-open */
  }
}

export function getReflectionEngineCycleSamples(): readonly ReflectionEngineCycleSample[] {
  return reflectionEngineCycleSamples;
}

export function incReflectionEngineSkippedOverlap(): void {
  reflectionEngineSkippedOverlapCount += 1;
}

export function getReflectionEngineSkippedOverlapCount(): number {
  return reflectionEngineSkippedOverlapCount;
}

/** Test-only reset, mirroring resetMetricsForTests() above but kept separate so a test targeting
 *  this instrumentation doesn't have to import/clear every other unrelated counter. */
export function resetReflectionEngineMetricsForTests(): void {
  reflectionEngineCycleSamples.length = 0;
  reflectionEngineSkippedOverlapCount = 0;
}
