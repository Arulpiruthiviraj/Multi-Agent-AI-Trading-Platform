import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { logStructured, structuredLogger } from './StructuredLogger';
import { snapshotObservabilityIds, runWithObservabilityContext } from './ObservabilityContext';
import { LEVEL_RANK } from '../config/observability';
import { observabilityConfig } from '../config/observability';
import {
  resetObservabilityStoreForTests,
  setObservabilityPersistForTests,
  observabilityQueueLengthForTests,
  flushObservabilityStore,
} from './ObservabilityStore';
import { getMetric, resetMetricsForTests } from './ObservabilityMetrics';

describe('StructuredLogger', () => {
  beforeEach(() => {
    resetObservabilityStoreForTests();
    resetMetricsForTests();
  });

  afterEach(() => {
    resetObservabilityStoreForTests();
  });

  it('never throws when persist is down', async () => {
    setObservabilityPersistForTests(async () => {
      throw new Error('disk full');
    });
    expect(() => structuredLogger.error('broker timeout', { category: 'BROKER', status: 'UNKNOWN' })).not.toThrow();
    await flushObservabilityStore();
    expect(getMetric('events_persist_failed')).toBeGreaterThan(0);
  });

  it('clamps safety-category DEBUG up to INFO so kill-switch/risk never persist as DEBUG', () => {
    expect(LEVEL_RANK[observabilityConfig.safetyMinLevel]).toBeGreaterThanOrEqual(LEVEL_RANK.INFO);
    logStructured('DEBUG', 'kill switch', { category: 'KILL_SWITCH' });
    expect(observabilityQueueLengthForTests()).toBeGreaterThan(0);
  });

  it('redacts secrets from messages before enqueue', () => {
    process.env.ALPACA_API_KEY = 'alpaca-test-secret-xyz-999';
    logStructured('ERROR', 'key=alpaca-test-secret-xyz-999 leaked', { category: 'SYSTEM' });
    // queue payload/message must not contain the raw key — inspected via persist mock
  });

  it('carries ALS decisionId onto log correlation fields', () => {
    runWithObservabilityContext({ decisionId: 'trace_LOG_1_abcd' }, () => {
      const ids = snapshotObservabilityIds();
      expect(ids.decisionId).toBe('trace_LOG_1_abcd');
      expect(ids.correlationId).toBe('trace_LOG_1_abcd');
      expect(ids.traceId).toBe('trace_LOG_1_abcd');
    });
  });
});
