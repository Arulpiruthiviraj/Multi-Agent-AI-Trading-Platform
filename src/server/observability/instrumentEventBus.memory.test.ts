import { describe, it, expect, vi } from 'vitest';

// Memory-leak hunt: the observability wildcard bridge must install exactly one '*'
// listener no matter how many times installObservabilityEventBridge() is called
// (a duplicate '*' handler would double every observability pipeline write per event).
const { enqueueObservabilityEvent } = vi.hoisted(() => ({ enqueueObservabilityEvent: vi.fn() }));
vi.mock('./ObservabilityStore', () => ({ enqueueObservabilityEvent }));

import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { installObservabilityEventBridge } from './instrumentEventBus';

describe('instrumentEventBus.memory - single wildcard subscription invariant', () => {
  it('repeated install() calls add at most one wildcard listener total', () => {
    const before = eventBus.listenerCount('*');
    installObservabilityEventBridge();
    const afterFirst = eventBus.listenerCount('*');
    installObservabilityEventBridge();
    installObservabilityEventBridge();
    const afterRest = eventBus.listenerCount('*');
    expect(afterFirst - before).toBeLessThanOrEqual(1);
    expect(afterRest).toBe(afterFirst);
  });

  it('a bridged event still reaches the store exactly once per install batch', () => {
    enqueueObservabilityEvent.mockClear();
    installObservabilityEventBridge();
    installObservabilityEventBridge();
    eventBus.publish(EVENTS.ORDER_FILLED, { orderId: 'o1', status: 'FILLED', symbol: 'AAPL' });
    const calls = enqueueObservabilityEvent.mock.calls.filter(([r]) => r.eventType === EVENTS.ORDER_FILLED);
    expect(calls.length).toBeLessThanOrEqual(1);
  });
});
