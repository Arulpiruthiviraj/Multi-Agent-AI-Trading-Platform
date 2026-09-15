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
