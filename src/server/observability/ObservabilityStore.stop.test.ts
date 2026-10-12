import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resetObservabilityStoreForTests,
  setObservabilityPersistForTests,
  flushObservabilityStore,
  enqueueObservabilityEvent,
  getObservabilityQueueSnapshot,
  observabilityQueueLengthForTests,
  stopObservabilityStore,
  type ObservabilityEventRow,
} from './ObservabilityStore';
import { resetMetricsForTests, getMetric } from './ObservabilityMetrics';
import { observabilityConfig } from '../config/observability';

/**
 * 2026-10-12 (L6): ObservabilityStore ran a batch-flush timer that was never cleared. These
 * tests prove the queue's drop path and failure path behave correctly, and that stop() clears
 * the batch-flush timer AND performs a final flush of pending events (the shutdown-drain
 * contract). The persist layer is stubbed via the module's own test hooks - the real SQLite
 * path is covered by ObservabilityStore.test.ts.
 */
describe('ObservabilityStore drop/failure paths + stop() (L6)', () => {
  let seq = 0;

  function makeEvent(id: string): ObservabilityEventRow {
    seq += 1;
    return {
      id, ts: Date.now(), level: 'INFO', category: 'SYSTEM', eventType: null,
      loggerName: 'test', message: `m${seq}`, sessionId: 'sess-1',
      correlationId: null, decisionId: null, traceId: null, orderId: null,
      symbol: null, component: null, payload: null,
    };
  }

  beforeEach(() => {
    resetObservabilityStoreForTests();
    resetMetricsForTests();
  });

  afterEach(() => {
    resetObservabilityStoreForTests();
    vi.useRealTimers();
  });

  it('drop path: a full buffer drops (and counts) instead of growing unboundedly', () => {
    const persisted: ObservabilityEventRow[] = [];
    setObservabilityPersistForTests(async (batch) => { persisted.push(...batch); });
    const origMax = observabilityConfig.maxQueueSize;
    (observabilityConfig as any).maxQueueSize = 3;
    try {
      for (let i = 0; i < 5; i++) enqueueObservabilityEvent(makeEvent(`drop-${i}`));
      // dropPolicy=newest: the 4th/5th events are refused; the queue keeps the first 3.
      expect(observabilityQueueLengthForTests()).toBe(3);
      expect(getMetric('events_dropped_queue_full')).toBe(2);
      expect(getObservabilityQueueSnapshot().pending).toBe(3);
    } finally {
      (observabilityConfig as any).maxQueueSize = origMax;
    }
  });

  it('failure path: a throwing persist discards the batch and counts it, without re-queueing', async () => {
    setObservabilityPersistForTests(async () => { throw new Error('disk down'); });
    enqueueObservabilityEvent(makeEvent('fail-1'));
    expect(observabilityQueueLengthForTests()).toBe(1);
    await flushObservabilityStore();
    // Logging isolation: the failed batch is discarded, not re-queued - trading must not
    // stall on a stuck disk, and the queue must not grow across failing flushes.
    expect(observabilityQueueLengthForTests()).toBe(0);
    expect(getMetric('events_persist_failed')).toBe(1);
    expect(getMetric('events_persisted')).toBe(0);
  });

  it('stop() clears the batch-flush timer and performs a final flush of pending events', async () => {
    vi.useFakeTimers();
    const persisted: ObservabilityEventRow[][] = [];
    setObservabilityPersistForTests(async (batch) => { persisted.push(batch); });
    const baselineTimers = vi.getTimerCount();

    enqueueObservabilityEvent(makeEvent('stop-1'));
    enqueueObservabilityEvent(makeEvent('stop-2'));
    expect(observabilityQueueLengthForTests()).toBe(2);
    expect(vi.getTimerCount()).toBe(baselineTimers + 1); // batch-flush timer armed

    await stopObservabilityStore();

    expect(persisted).toHaveLength(1); // final flush ran exactly once
    expect(persisted[0].map((r) => r.id)).toEqual(['stop-1', 'stop-2']);
    expect(observabilityQueueLengthForTests()).toBe(0);
    expect(vi.getTimerCount()).toBe(baselineTimers); // timer cleared, none re-armed

    // Advancing well past batchFlushMs must not produce a second flush from a dangling timer.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(persisted).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(baselineTimers);
  });

  it('stop() is safe on an empty queue', async () => {
    setObservabilityPersistForTests(async () => { throw new Error('must not be called'); });
    await expect(stopObservabilityStore()).resolves.toBeUndefined();
    expect(observabilityQueueLengthForTests()).toBe(0);
  });
});
