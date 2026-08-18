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
  eventLoopDelayMs: number | null;
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
