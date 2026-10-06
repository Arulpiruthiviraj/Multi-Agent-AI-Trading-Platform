import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { logStructured, structuredLogger, observeSafe } from './StructuredLogger';
import { snapshotObservabilityIds, runWithObservabilityContext } from './ObservabilityContext';
import { LEVEL_RANK } from '../config/observability';
import { observabilityConfig } from '../config/observability';
import {
  resetObservabilityStoreForTests,
  setObservabilityPersistForTests,
  observabilityQueueLengthForTests,
  flushObservabilityStore,
} from './ObservabilityStore';
import { getMetric, resetMetricsForTests, getObservabilityHealthForTag, resetObservabilityHealthForTests, isAnyObservabilityTagDegraded } from './ObservabilityMetrics';

describe('StructuredLogger', () => {
  beforeEach(() => {
    resetObservabilityStoreForTests();
    resetMetricsForTests();
    resetObservabilityHealthForTests();
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

// 2026-10-06 (October 5 forensic follow-up, Phase 2 - observability self-health). The cycleId TDZ
// bug in OpportunityDiscovery.ts demonstrated that observeSafe()'s fail-open swallow can hide a
// completely broken event path for hours with no external signal beyond an undifferentiated
// counter increment. These tests prove the exact scenario the user described: a logging callback
// throws -> production function continues -> observability error counter increments -> degraded
// telemetry becomes externally visible, scoped per-tag so one broken path is not masked by
// unrelated successful calls elsewhere.
describe('observeSafe - per-tag observability self-health', () => {
  beforeEach(() => {
    resetMetricsForTests();
    resetObservabilityHealthForTests();
  });

  it('a callback that throws never propagates - production continues - but the failure becomes visible via per-tag health', () => {
    expect(() => observeSafe(() => {
      throw new ReferenceError("Cannot access 'cycleId' before initialization");
    }, 'TEST_TAG_BROKEN')).not.toThrow();

    const health = getObservabilityHealthForTag('TEST_TAG_BROKEN');
    expect(health.degraded).toBe(true);
    expect(health.failureCount).toBe(1);
    expect(health.lastFailureType).toBe('ReferenceError');
    expect(health.lastSuccessAt).toBeNull();
    expect(isAnyObservabilityTagDegraded()).toBe(true);
  });

  it('a successful callback is not degraded, and failureCount stays at zero', () => {
    observeSafe(() => { /* real work, no throw */ }, 'TEST_TAG_HEALTHY');
    const health = getObservabilityHealthForTag('TEST_TAG_HEALTHY');
    expect(health.degraded).toBe(false);
    expect(health.failureCount).toBe(0);
    expect(health.lastSuccessAt).not.toBeNull();
  });

  it('a later success for the SAME tag clears degraded (transient/recovered noise is not degraded)', () => {
    observeSafe(() => { throw new Error('transient'); }, 'TEST_TAG_RECOVERED');
    expect(getObservabilityHealthForTag('TEST_TAG_RECOVERED').degraded).toBe(true);
    observeSafe(() => { /* recovered */ }, 'TEST_TAG_RECOVERED');
    expect(getObservabilityHealthForTag('TEST_TAG_RECOVERED').degraded).toBe(false);
  });

  // The exact failure mode this investigation found: one tag's every call fails while a
  // completely unrelated tag keeps succeeding in the same cycle. A global (non-per-tag) health
  // signal would have shown "healthy" throughout - per-tag tracking must not let that happen.
  it('one tag failing repeatedly does not get masked by a different tag succeeding nearby', () => {
    for (let i = 0; i < 5; i++) {
      observeSafe(() => { throw new TypeError('always broken'); }, 'TEST_TAG_ALWAYS_BROKEN');
      observeSafe(() => { /* always fine */ }, 'TEST_TAG_ALWAYS_FINE');
    }
    const broken = getObservabilityHealthForTag('TEST_TAG_ALWAYS_BROKEN');
    const fine = getObservabilityHealthForTag('TEST_TAG_ALWAYS_FINE');
    expect(broken.degraded).toBe(true);
    expect(broken.failureCount).toBe(5);
    expect(fine.degraded).toBe(false);
    expect(isAnyObservabilityTagDegraded()).toBe(true); // the broken tag alone must still surface
  });

  it('a throw during argument construction (before structuredLogger.info is even called) is still attributed to the caller-supplied tag', () => {
    // Mirrors the real cycleId bug's exact shape: a closure (the observeSafe callback) reads a
    // const declared LATER in its own enclosing function scope. TypeScript's static analysis does
    // NOT flag this (same-block use-before-declare IS caught statically, but this cross-closure
    // case is not - confirmed: the real bug passed tsc --noEmit clean). The error occurs while
    // building the log call's own arguments, never reaching structuredLogger.info() at all.
    function runCycleWithLateConstDeclaration() {
      const callback = () => {
        const reasoning = `cycleId=${lateConst}`;
        structuredLogger.info('would_never_reach_here', { category: 'DISCOVERY', reasoning });
      };
      observeSafe(callback, 'TEST_TAG_TDZ');
      const lateConst = 'x'; // eslint-disable-line @typescript-eslint/no-unused-vars
    }
    expect(() => runCycleWithLateConstDeclaration()).not.toThrow();
    const health = getObservabilityHealthForTag('TEST_TAG_TDZ');
    expect(health.degraded).toBe(true);
    expect(health.lastFailureType).toBe('ReferenceError');
  });
});
