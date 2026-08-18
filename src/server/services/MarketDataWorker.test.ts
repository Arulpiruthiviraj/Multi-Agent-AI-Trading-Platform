import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
    static CONNECTING = 0;
    static CLOSED = 3;
    readyState = 1;
    listeners: Record<string, Function[]> = {};
    sentMessages: any[] = [];
    on(event: string, cb: Function) {
      (this.listeners[event] ||= []).push(cb);
    }
    removeAllListeners() {
      this.listeners = {};
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
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    constructor() {
      const instance = new MockWebSocket();
      instances.push(instance);
      return instance;
    }
  },
}));

const { emitMarketData, emitSpy, subscribeSpy, ideaGenEnabled } = vi.hoisted(() => ({
  emitMarketData: vi.fn(),
  emitSpy: vi.fn(),
  subscribeSpy: vi.fn(),
  ideaGenEnabled: { value: true },
}));
vi.mock('../core/EventBus', () => ({ eventBus: { emitMarketData, emit: emitSpy, subscribe: subscribeSpy } }));
vi.mock('../core/ideaGenerationGate', () => ({ isLiveIdeaGenerationEnabled: () => ideaGenEnabled.value }));

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
    subscribeSpy.mockClear();
    ideaGenEnabled.value = true;
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_SECRET_KEY = 'test-secret';
    worker = new MarketDataWorker();
    worker.start();
  });

  afterEach(() => {
    worker.stop();
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

  it('after the socket closes, start() opens a new handshake instead of no-op on the dead handle', () => {
    const ws = instances[0];
    ws.emit('close');
    expect(worker.isConnected()).toBe(false);

    worker.start();
    expect(instances.length).toBe(2);
  });

  it('reconnect() tears down the current socket and starts a new one', () => {
    const first = instances[0];
    worker.reconnect();
    expect(first.readyState).toBe(MockWebSocket.CLOSED);
    expect(instances.length).toBe(2);
  });

  it('caches quotes but does not emit MARKET_DATA when Autobot/trading is gated off', () => {
    ideaGenEnabled.value = false;
    const ws = instances[0];
    authenticate(ws);
    sendMessage(ws, { T: 'q', S: 'AAPL', bp: 150.25, bs: 100, t: '2026-01-15T14:30:00.000000000Z' });
    expect(emitMarketData).not.toHaveBeenCalled();
    expect(worker.getLatestPrice('AAPL')).toBe(150.25);
    expect(worker.getLatestPrice('aapl')).toBe(150.25);
  });

  it('rejects a future-timestamp tick and does not cache or emit it', () => {
    const ws = instances[0];
    authenticate(ws);
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    sendMessage(ws, { T: 'q', S: 'AAPL', bp: 150.25, bs: 100, t: future });
    expect(emitMarketData).not.toHaveBeenCalled();
    expect(worker.getLatestPrice('AAPL')).toBeNull();
    expect(emitSpy).toHaveBeenCalledWith('MARKET_DATA_REJECTED', expect.objectContaining({
      symbol: 'AAPL',
      reason: 'FUTURE_TIMESTAMP',
    }));
  });

  it('rejects an out-of-order tick older than last accepted by more than tickOutOfOrderEpsilonMs', async () => {
    const { tradingSafety } = await import('../config/tradingSafety');
    const ws = instances[0];
    authenticate(ws);
    sendMessage(ws, { T: 'q', S: 'AAPL', bp: 150.25, bs: 100, t: '2026-01-15T14:30:10.000000000Z' });
    expect(emitMarketData).toHaveBeenCalledTimes(1);
    emitMarketData.mockClear();
    emitSpy.mockClear();
    const older = new Date(Date.parse('2026-01-15T14:30:10.000Z') - tradingSafety.tickOutOfOrderEpsilonMs - 1000).toISOString();
    sendMessage(ws, { T: 'q', S: 'AAPL', bp: 149.0, bs: 100, t: older });
    expect(emitMarketData).not.toHaveBeenCalled();
    expect(worker.getLatestPrice('AAPL')).toBe(150.25);
    expect(emitSpy).toHaveBeenCalledWith('MARKET_DATA_REJECTED', expect.objectContaining({
      symbol: 'AAPL',
      reason: 'OUT_OF_ORDER',
    }));
  });

  it('does not drop a delayed WS reorder within tickOutOfOrderEpsilonMs', async () => {
    const { tradingSafety } = await import('../config/tradingSafety');
    const ws = instances[0];
    authenticate(ws);
    sendMessage(ws, { T: 'q', S: 'AAPL', bp: 150.25, bs: 100, t: '2026-01-15T14:30:10.000000000Z' });
    emitMarketData.mockClear();
    const slightlyOlder = new Date(Date.parse('2026-01-15T14:30:10.000Z') - Math.min(1000, tradingSafety.tickOutOfOrderEpsilonMs / 2)).toISOString();
    sendMessage(ws, { T: 'q', S: 'AAPL', bp: 150.10, bs: 100, t: slightlyOlder });
    expect(emitMarketData).toHaveBeenCalledTimes(1);
  });

  it('after authenticate, subscribes to config/markets.json US benchmarks when nothing else was subscribed', () => {
    const ws = instances[0];
    authenticate(ws);
    const sub = ws.sentMessages.find((m: any) => m.action === 'subscribe');
    expect(sub).toBeTruthy();
    expect(sub.quotes).toEqual(expect.arrayContaining(['SPY', 'QQQ']));
  });

  it('unions US benchmarks even if a pre-auth subscribe already added another name', () => {
    worker.subscribe('AAPL');
    const ws = instances[0];
    authenticate(ws);
    const subs = ws.sentMessages.filter((m: any) => m.action === 'subscribe');
    const afterAuth = subs[subs.length - 1];
    expect(afterAuth.quotes).toEqual(expect.arrayContaining(['AAPL', 'SPY', 'QQQ', 'IWM', 'DIA']));
  });

  it('rejects garbage tickers and never evicts protected benchmarks', () => {
    authenticate(instances[0]);
    worker.subscribe('NOT A TICKER');
    worker.subscribe('!!!!!!');
    expect(worker.getActiveSymbols()).not.toContain('NOT A TICKER');
    worker.unsubscribe('SPY');
    expect(worker.getActiveSymbols()).toContain('SPY');
  });

  it('refuses non-protected subscribes once the configured cap is reached', async () => {
    const { continuousIntelligence } = await import('../config/continuousIntelligence');
    const cap = continuousIntelligence.maxActiveSubscriptions;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let requested = 0;
    outer: for (let i = 0; i < 26; i++) {
      for (let j = 0; j < 26; j++) {
        worker.subscribe(`ZZ${alphabet[i]}${alphabet[j]}`);
        requested += 1;
        if (requested > cap + 8) break outer;
      }
    }
    expect(worker.getActiveSymbols().length).toBe(cap);
  });

  it('WATCHLIST_SUBSCRIBE_REQUESTED expands the IEX set without placing an order', () => {
    const handler = subscribeSpy.mock.calls.find((c: unknown[]) => c[0] === 'WATCHLIST_SUBSCRIBE_REQUESTED')?.[1] as ((p: { symbol?: string }) => void) | undefined;
    expect(handler).toBeTypeOf('function');
    handler!({ symbol: 'MSFT' });
    expect(worker.getActiveSymbols()).toContain('MSFT');
    expect(emitSpy).not.toHaveBeenCalledWith(expect.stringMatching(/ORDER/), expect.anything());
  });
});
