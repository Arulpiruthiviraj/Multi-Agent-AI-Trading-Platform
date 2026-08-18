import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface TracingConfig {
  requireTraceIdOnCoreEvents: boolean;
  warnOnlyOnMissingTraceId: boolean;
  batchFlushMs: number;
  maxBatchSize: number;
  traceIdPrefix: string;
  coreEventsRequiringTraceId: string[];
}

export const tracingConfig = loadRepoConfigJson<TracingConfig>('tracing.json');
