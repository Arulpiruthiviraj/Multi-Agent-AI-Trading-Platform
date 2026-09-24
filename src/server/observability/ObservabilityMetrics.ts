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
