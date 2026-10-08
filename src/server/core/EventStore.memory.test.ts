import { describe, it, expect, vi, beforeEach } from 'vitest';

// Memory-leak hunt: EventStore in-memory rings (recentEvents, tradeTraces).
// DB persistence is mocked - this file measures only in-memory retention, not disk.

vi.mock('../db', () => ({
  db: { insert: () => ({ values: () => Promise.resolve() }) },
  sqliteDb: {},
}));

// ObservabilityStore pulls db too; EventStore does not import it, but guard anyway.
vi.mock('../observability/ObservabilityStore', () => ({
  enqueueObservabilityEvent: vi.fn(),
}));

import { eventBus } from './EventBus';
import { EVENTS } from './eventNames';
import { recentEvents, tradeTraces } from './EventStore';
import { runtimeIntervals } from '../config/runtimeIntervals';

describe('EventStore.memory - ring buffers stay bounded under event volume', () => {
  beforeEach(() => {
    recentEvents.length = 0;
    for (const k of Object.keys(tradeTraces)) delete tradeTraces[k];
  });

  it('recentEvents ring never exceeds eventStoreMaxRecentEvents', () => {
    const cap = runtimeIntervals.eventStoreMaxRecentEvents;
    expect(cap).toBeGreaterThan(0);
    const total = cap * 3;
    for (let i = 0; i < total; i++) {
      // MARKET_DATA is a persisted event type; hot-tick path keeps payloads tiny.
      eventBus.emit(EVENTS.MARKET_DATA, { symbol: 'AAPL', price: 100 + i, volume: 1000, timestamp: new Date().toISOString() });
    }
    expect(recentEvents.length).toBeLessThanOrEqual(cap);
    expect(recentEvents.length).toBeGreaterThan(0);
  });

  it('tradeTraces evicts oldest correlationIds beyond eventStoreMaxTraces', () => {
    const cap = runtimeIntervals.eventStoreMaxTraces;
    expect(cap).toBeGreaterThan(0);
    const total = cap + 100;
    for (let i = 0; i < total; i++) {
      // TRADE_IDEA_GENERATED goes through EventBus's idea gate - use RISK_ASSESSMENT_COMPLETED,
      // a persisted type with a traceId-carrying payload that exercises the per-correlationId map.
      eventBus.emit(EVENTS.RISK_ASSESSMENT_COMPLETED, {
        traceId: `trace-${i}`,
        symbol: 'AAPL',
        approved: i % 2 === 0,
      });
    }
    const keys = Object.keys(tradeTraces);
    expect(keys.length).toBeLessThanOrEqual(cap);
    // Oldest ids evicted, newest retained.
    expect(keys).not.toContain('trace-0');
    expect(keys).toContain(`trace-${total - 1}`);
  });

  it('events without correlationId never enter tradeTraces (map cannot grow unboundedly)', () => {
    for (let i = 0; i < 500; i++) {
      eventBus.emit(EVENTS.MARKET_DATA, { symbol: 'AAPL', price: 100, volume: 1, timestamp: 't' });
    }
    expect(Object.keys(tradeTraces).length).toBe(0);
  });
});
