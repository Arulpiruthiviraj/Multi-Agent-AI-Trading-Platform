/**
 * Loads config/observability.json. Retention, sampling, queue bounds, and taxonomy.
 * Missing required keys fail boot. Numbers are never TS literals at call sites.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export type ObservabilityLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

export interface ObservabilityEventTaxonomyEntry {
  category: string;
  defaultLevel: ObservabilityLevel;
  sampled?: boolean;
}

export interface ObservabilityConfig {
  schemaVersion: number;
  sessionIdPrefix: string;
  levels: ObservabilityLevel[];
  persistMinLevel: ObservabilityLevel;
  consoleMinLevel: ObservabilityLevel;
  batchFlushMs: number;
  maxBatchSize: number;
  maxQueueSize: number;
  dropPolicy: 'newest' | 'oldest';
  retentionDays: number;
  retentionSweepMs: number;
  marketDataSampleEveryN: number;
  processTelemetryIntervalMs: number;
  processTelemetryRingSize: number;
  /** Readiness pass (2026-09-04): processTelemetry's own ring buffer is in-memory only and lost on
   *  process death - exactly the blind spot that made the Sept 2-3 silent-death investigations
   *  depend on Windows' own external resource-exhaustion detector instead of anything Argus itself
   *  recorded. This is a much coarser, DURABLE (persisted via structuredLogger -> observability_events,
   *  survives restarts) sample specifically for post-mortem trend analysis, not live diagnostics. */
  memoryTelemetryPersistIntervalMs: number;
  memoryTelemetryWarningRssMb: number;
  memoryTelemetryCriticalRssMb: number;
  /** Committed (pagefile/virtual), NOT resident, memory thresholds for the Chronos sidecar. Separate
   *  from the RSS thresholds because committed is legitimately a large multiple of RSS for a healthy
   *  PyTorch process - see config/observability.json's comment for the measured evidence. */
  memoryTelemetryWarningCommittedMb: number;
  memoryTelemetryCriticalCommittedMb: number;
  marketDataPersist: boolean;
  maxPayloadChars: number;
  promptHashLength: number;
  legacyJsonlMaxBytes: number;
  legacyJsonlMaxBackups: number;
  safetyCategories: string[];
  safetyMinLevel: ObservabilityLevel;
  eventTaxonomy: Record<string, ObservabilityEventTaxonomyEntry>;
}

const LEVEL_SET = new Set(['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']);

const REQUIRED_NUMBERS: (keyof ObservabilityConfig)[] = [
  'schemaVersion', 'batchFlushMs', 'maxBatchSize', 'maxQueueSize',
  'retentionDays', 'retentionSweepMs', 'marketDataSampleEveryN',
  'processTelemetryIntervalMs', 'processTelemetryRingSize',
  'memoryTelemetryPersistIntervalMs', 'memoryTelemetryWarningRssMb', 'memoryTelemetryCriticalRssMb',
  'memoryTelemetryWarningCommittedMb', 'memoryTelemetryCriticalCommittedMb',
  'maxPayloadChars', 'promptHashLength',
  'legacyJsonlMaxBytes', 'legacyJsonlMaxBackups',
];

function loadObservabilityConfig(): ObservabilityConfig {
  const raw = loadRepoConfigJson<ObservabilityConfig>('observability.json');
  for (const key of REQUIRED_NUMBERS) {
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key] as number)) {
      throw new Error(`config/observability.json missing numeric field: ${key}`);
    }
  }
  if (!Array.isArray(raw.levels) || raw.levels.length === 0) {
    throw new Error('config/observability.json missing levels array');
  }
  if (!LEVEL_SET.has(raw.persistMinLevel) || !LEVEL_SET.has(raw.consoleMinLevel) || !LEVEL_SET.has(raw.safetyMinLevel)) {
    throw new Error('config/observability.json has invalid log level');
  }
  if (!raw.eventTaxonomy || typeof raw.eventTaxonomy !== 'object') {
    throw new Error('config/observability.json missing eventTaxonomy');
  }
  if (!Array.isArray(raw.safetyCategories) || raw.safetyCategories.length === 0) {
    throw new Error('config/observability.json missing safetyCategories');
  }
  return raw;
}

export const observabilityConfig = loadObservabilityConfig();

export const LEVEL_RANK: Record<ObservabilityLevel, number> = {
  TRACE: 10,
  DEBUG: 20,
  INFO: 30,
  WARN: 40,
  ERROR: 50,
  FATAL: 60,
};

export function isObservabilityLevel(value: string): value is ObservabilityLevel {
  return LEVEL_SET.has(value);
}
