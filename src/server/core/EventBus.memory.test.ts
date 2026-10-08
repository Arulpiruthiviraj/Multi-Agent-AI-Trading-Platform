import { describe, it, expect, vi, afterEach } from 'vitest';
import { eventBus } from './EventBus';
import { EVENTS } from './eventNames';

// Memory-leak hunt repros: OBSERVABILITY / EVENT BUS subsystem.
// Each test drives real volume through the production singleton eventBus and
// asserts listener/state counts stay bounded. A REAL_LEAK would show listenerCount
// growth or unbounded heap growth here.

const uniqueEvent = (tag: string) => `memleak-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const added: Array<{ event: string; listener: (...args: any[]) => void }> = [];

afterEach(() => {
  for (const { event, listener } of added.splice(0)) {
    eventBus.off(event, listener);
  }
});

function measureHeapBytes(fn: () => void): number {
  if (typeof global.gc !== 'function') return NaN;
  global.gc();
  const before = process.memoryUsage().heapUsed;
  fn();
  global.gc();
  return process.memoryUsage().heapUsed - before;
}

describe('EventBus.memory - listener-count stability under emission volume', () => {
  it('emitting 20k events does not accumulate listeners or observable state', () => {
    const event = uniqueEvent('emit');
    let calls = 0;
    const listener = () => { calls += 1; };
    eventBus.on(event, listener);
    added.push({ event, listener });
    const baseline = eventBus.listenerCount(event);

    for (let i = 0; i < 20000; i++) {
      eventBus.emit(event, { seq: i, symbol: 'AAPL', price: 100 + i * 0.01 });
    }

    expect(eventBus.listenerCount(event)).toBe(baseline);
    expect(calls).toBe(20000);
  });

  it('repeated subscribe/unsubscribe cycles leave listenerCount at baseline', () => {
    const event = uniqueEvent('cycles');
    const baseline = eventBus.listenerCount(event);

    for (let cycle = 0; cycle < 1000; cycle++) {
      const listener = () => { /* per-cycle subscriber like an agent start/stop */ };
      eventBus.subscribe(event, listener);
      eventBus.emit(event, { cycle });
      eventBus.unsubscribe(event, listener);
    }

    expect(eventBus.listenerCount(event)).toBe(baseline);
  });

  it('unsubscribed listeners never fire after teardown (no stale dispatch)', () => {
    const event = uniqueEvent('stale');
    let staleCalls = 0;
    for (let cycle = 0; cycle < 50; cycle++) {
      const listener = () => { staleCalls += 1; };
      eventBus.on(event, listener);
      eventBus.emit(event, {});
      eventBus.off(event, listener);
    }
    eventBus.emit(event, {});
    expect(staleCalls).toBe(50);
    expect(eventBus.listenerCount(event)).toBe(0);
  });

  it('heap stays bounded across 50k emissions (WARMUP_ONLY, not a leak)', () => {
    const event = uniqueEvent('heap');
    const listener = () => { /* noop */ };
    eventBus.on(event, listener);
    added.push({ event, listener });
    if (typeof global.gc !== 'function') {
      console.warn('[EventBus.memory] global.gc unavailable (run with NODE_OPTIONS=--expose-gc); heap assertion skipped');
      return;
    }
    const delta = measureHeapBytes(() => {
      for (let i = 0; i < 50000; i++) {
        eventBus.emit(event, { seq: i, payload: { nested: [i, 'x', { a: 1 }] } });
      }
    });
    // Generous bound: transient dispatch arrays must not retain per-emit memory.
    // A leak would retain O(emissions) bytes (GB-scale at 50k); warmup noise is MB-scale.
    expect(delta).toBeLessThan(50 * 1024 * 1024);
  });
});

describe('EventBus.memory - wildcard dispatch cost', () => {
  it('many emissions with wildcard listeners installed do not grow listenerCount', () => {
    const event = uniqueEvent('wild');
    const wild = (_type: string, _payload: any) => { /* noop */ };
    eventBus.on('*', wild);
    added.push({ event: '*', listener: wild });
    const baselineWild = eventBus.listenerCount('*');

    for (let i = 0; i < 5000; i++) {
      eventBus.emit(event, { seq: i });
    }

    expect(eventBus.listenerCount('*')).toBe(baselineWild);
    expect(eventBus.listenerCount(event)).toBe(0);
  });
});

// Node's 50-listener ceiling must stay meaningful: production boot registers a fixed,
// small set of permanent listeners; exceeding it throws a visible warning rather than
// silently stacking handlers.
describe('EventBus.memory - max-listeners guard', () => {
  it('keeps the 50-listener ceiling (misbehaving subscriber gets warned, not silent)', () => {
    expect(eventBus.getMaxListeners()).toBe(50);
  });
});
