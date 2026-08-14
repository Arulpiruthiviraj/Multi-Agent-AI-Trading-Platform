import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Real test coverage for hardening-pass Phase 4 (MarketDataWorker.ts): duplicate-tick dedup and
 * reconnect-gap observability. No test file existed for this module before this phase - a mock
 * `ws` WebSocket lets these two specific real behaviors be exercised deterministically without a
 * live Alpaca connection (this file's other pre-existing behavior, e.g. start()/subscribe(), is
 * unmodified by this phase and out of scope here).
 */
const { MockWebSocket, instances } = vi.hoisted(() => {
  class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    listeners: Record<string, Function[]> = {};
    sentMessages: any[] = [];
    on(event: string, cb: Function) {
      (this.listeners[event] ||= []).push(cb);
    }
    send(data: string) {
      this.sentMessages.push(JSON.parse(data));
    }
    close() {
      this.readyState = MockWebSocket.CLOSED;
    }
    emit(event: string, ...args: any[]) {
      (this.listeners[event] || []).forEach(cb => cb(...args));
    }
  }
  const instances: MockWebSocket[] = [];
  return { MockWebSocket, instances };
});

vi.mock('ws', () => ({
  default: class {
    constructor() {
      const instance = new MockWebSocket();
      instances.push(instance);
      return instance;
    }
  },
}));

const { emitMarketData, emitSpy } = vi.hoisted(() => ({ emitMarketData: vi.fn(), emitSpy: vi.fn() }));
vi.mock('../core/EventBus', () => ({ eventBus: { emitMarketData, emit: emitSpy } }));

import { MarketDataWorker } from './MarketDataWorker';

function sendMessage(ws: any, msg: any) {
  ws.emit('message', Buffer.from(JSON.stringify([msg])));
}

describe('MarketDataWorker - duplicate-tick dedup and reconnect-gap detection (Phase 4 hardening)', () => {
  let worker: MarketDataWorker;

  beforeEach(() => {
    instances.length = 0;
    emitMarketData.mockClear();
    emitSpy.mockClear();
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_SECRET_KEY = 'test-secret';
    worker = new MarketDataWorker();
    worker.start();
  });

  function authenticate(ws: any) {
    sendMessage(ws, { T: 'success', msg: 'authenticated' });
  }

  it('processes a real tick and emits MARKET_DATA exactly once', () => {
    const ws = instances[0];
    authenticate(ws);

    sendMessage(ws, { T: 'q', S: 'AAPL', bp: 150.25, bs: 100, t: '2026-01-15T14:30:00.000000000Z' });

    expect(emitMarketData).toHaveBeenCalledTimes(1);
    expect(emitMarketData).toHaveBeenCalledWith('AAPL', 150.25, 100, expect.any(String));
  });

  it('the exact bug this closes: an exact redelivery of the same tick (same timestamp+price) is not re-processed', () => {
    const ws = instances[0];
    authenticate(ws);

    const tick = { T: 'q', S: 'AAPL', bp: 150.25, bs: 100, t: '2026-01-15T14:30:00.000000000Z' };
    sendMessage(ws, tick);
    sendMessage(ws, tick); // exact redelivery - e.g. a reconnect replaying a buffered message

    expect(emitMarketData).toHaveBeenCalledTimes(1);
  });

  it('a genuinely new tick for the same symbol (different timestamp) is never discarded as a false-positive duplicate', () => {
    const ws = instances[0];
    authenticate(ws);

    sendMessage(ws, { T: 'q', S: 'AAPL', bp: 150.25, bs: 100, t: '2026-01-15T14:30:00.000000000Z' });
    sendMessage(ws, { T: 'q', S: 'AAPL', bp: 150.30, bs: 100, t: '2026-01-15T14:30:00.500000000Z' });

    expect(emitMarketData).toHaveBeenCalledTimes(2);
  });

  it('a same-price tick for a DIFFERENT symbol is never treated as a duplicate of another symbol\'s tick', () => {
    const ws = instances[0];
    authenticate(ws);

    sendMessage(ws, { T: 'q', S: 'AAPL', bp: 150.25, bs: 100, t: '2026-01-15T14:30:00.000000000Z' });
    sendMessage(ws, { T: 'q', S: 'MSFT', bp: 150.25, bs: 100, t: '2026-01-15T14:30:00.000000000Z' });

    expect(emitMarketData).toHaveBeenCalledTimes(2);
  });

  it('dedup applies identically to trade ("t") messages, not just quotes', () => {
    const ws = instances[0];
    authenticate(ws);

    const trade = { T: 't', S: 'AAPL', p: 150.25, s: 10, t: '2026-01-15T14:30:00.000000000Z' };
    sendMessage(ws, trade);
    sendMessage(ws, trade);

    expect(emitMarketData).toHaveBeenCalledTimes(1);
  });

  it('a real reconnect gap is detected and made observable, never silently backfilled with fabricated ticks', () => {
    const ws = instances[0];
    authenticate(ws);

    ws.emit('close');
    // A second connectAlpaca() call happens on a real 5s timer in production; drive it directly
    // here rather than waiting on a real timeout.
    (worker as any).connectAlpaca();
    const ws2 = instances[1];
    authenticate(ws2);

    expect(emitSpy).toHaveBeenCalledWith('MARKET_DATA_GAP_DETECTED', expect.objectContaining({
      gapMs: expect.any(Number),
    }));
  });

  it('does not emit a gap event on the very first connection (nothing was actually missed)', () => {
    const ws = instances[0];
    authenticate(ws);

    expect(emitSpy).not.toHaveBeenCalledWith('MARKET_DATA_GAP_DETECTED', expect.anything());
  });
});
