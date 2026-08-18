import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eventBus } from '../core/EventBus';
import { installObservabilityEventBridge, resetObservabilityBridgeForTests } from './instrumentEventBus';
import {
  resetObservabilityStoreForTests,
  setObservabilityEnqueueBlockedForTests,
  setObservabilityPersistForTests,
  flushObservabilityStore,
} from './ObservabilityStore';
import { resetMetricsForTests, getMetric } from './ObservabilityMetrics';

describe('observability persist isolation from trading', () => {
  beforeEach(() => {
    resetObservabilityStoreForTests();
    resetObservabilityBridgeForTests();
    resetMetricsForTests();
    installObservabilityEventBridge();
  });

  afterEach(() => {
    resetObservabilityStoreForTests();
    resetObservabilityBridgeForTests();
  });

  it('logger/store failure does not prevent a later trading listener from running', () => {
    setObservabilityEnqueueBlockedForTests(true);
    setObservabilityPersistForTests(async () => { throw new Error('logger down'); });
    const trading = vi.fn();
    const event = `obs-trade-${Date.now()}`;
    eventBus.on(event, trading);
    expect(() => eventBus.emit(event, { traceId: 'trace_SAFE_1_ab12', symbol: 'SAFE', side: 'BUY' })).not.toThrow();
    expect(trading).toHaveBeenCalledTimes(1);
    eventBus.off(event, trading);
  });

  it('does not mark an UNKNOWN submit as FILLED', async () => {
    const statuses: string[] = [];
    eventBus.on('ORDER_EXECUTED', (p: any) => statuses.push(p.status));
    eventBus.emit('ORDER_EXECUTED', {
      traceId: 'trace_TO_1_ffff',
      id: 'ord-timeout',
      symbol: 'AAPL',
      status: 'PENDING',
      submitOutcome: 'UNKNOWN',
    });
    expect(statuses).toEqual(['PENDING']);
    expect(statuses).not.toContain('FILLED');
    await flushObservabilityStore();
    expect(getMetric('orders_unknown')).toBeGreaterThan(0);
  });
});
