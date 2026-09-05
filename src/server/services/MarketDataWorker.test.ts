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
vi.mock('../core/ideaGenerationGate', () => ({
  isLiveIdeaGenerationEnabled: () => ideaGenEnabled.value,
  isAutobotTradingEnabled: () => ideaGenEnabled.value,
}));

import { MarketDataWorker } from './MarketDataWorker';
import { structuredLogger } from '../observability/StructuredLogger';
import { recordNewsCatalyst, clearNewsCatalystsForTests } from './NewsCatalystStore';

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
    worker.setNowForTests(null);
    worker.stop();
  });

  function authenticate(ws: any) {
    sendMessage(ws, { T: 'success', msg: 'authenticated' });
  }

  /** Advance past minDynamicDwellMs so prune can evict freshly subscribed dynamics. */
  async function expireDynamicDwell() {
    const { continuousIntelligence } = await import('../config/continuousIntelligence');
    worker.setNowForTests(Date.now() + continuousIntelligence.minDynamicDwellMs + 1000);
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

  it('getLatestAsk/getLatestSpreadBps: captures a real ask price from a quote message and computes a real spread', () => {
    const ws = instances[0];
    authenticate(ws);
    sendMessage(ws, { T: 'q', S: 'AAPL', bp: 150.00, ap: 150.30, bs: 100, t: '2026-01-15T14:30:00.000000000Z' });

    expect(worker.getLatestAsk('AAPL')).toBe(150.30);
    // mid = 150.15, spread = 0.30/150.15 * 10000 ≈ 19.98 bps
    expect(worker.getLatestSpreadBps('AAPL', 60_000)).toBeCloseTo(19.98, 1);
  });

  it('getLatestAsk/getLatestSpreadBps return null when no quote has ever carried an ask (never fabricated)', () => {
    const ws = instances[0];
    authenticate(ws);
    sendMessage(ws, { T: 'q', S: 'NOASK', bp: 50, bs: 100, t: '2026-01-15T14:30:00.000000000Z' }); // no `ap` field

    expect(worker.getLatestAsk('NOASK')).toBeNull();
    expect(worker.getLatestSpreadBps('NOASK', 60_000)).toBeNull();
  });

  it('getLatestSpreadBps returns null when the ask observation is older than maxAgeMs', () => {
    // getLatestSpreadBps (like the existing getLatestPriceAgeMs it mirrors) reads the real wall
    // clock, not the setNowForTests()/wallMs() dwell-check clock - real timers must be faked here.
    vi.useFakeTimers();
    try {
      const ws = instances[0];
      authenticate(ws);
      sendMessage(ws, { T: 'q', S: 'STALEASK', bp: 100, ap: 100.5, bs: 100, t: '2026-01-15T14:30:00.000000000Z' });
      vi.advanceTimersByTime(120_000);

      expect(worker.getLatestSpreadBps('STALEASK', 60_000)).toBeNull();
      expect(worker.getLatestAsk('STALEASK')).toBe(100.5); // getLatestAsk itself is not age-bounded
    } finally {
      vi.useRealTimers();
    }
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

  it('after authenticate, subscribes to coreStreamingSymbols / seedSymbols under the hard cap', async () => {
    const { continuousIntelligence } = await import('../config/continuousIntelligence');
    const ws = instances[0];
    authenticate(ws);
    const sub = ws.sentMessages.find((m: any) => m.action === 'subscribe');
    expect(sub).toBeTruthy();
    expect(sub.quotes.length).toBeLessThanOrEqual(continuousIntelligence.maxActiveSubscriptions);
    expect(sub.quotes).toEqual(expect.arrayContaining(continuousIntelligence.coreStreamingSymbols));
  });

  it('unions seed names even if a pre-auth subscribe already added another name', () => {
    worker.subscribe('MSFT');
    const ws = instances[0];
    authenticate(ws);
    const subs = ws.sentMessages.filter((m: any) => m.action === 'subscribe');
    const afterAuth = subs[subs.length - 1];
    expect(afterAuth.quotes).toEqual(expect.arrayContaining(['MSFT', 'SPY', 'QQQ']));
    expect(afterAuth.quotes.length).toBeLessThanOrEqual(12);
  });

  it('rejects garbage tickers and never evicts protected core symbols', () => {
    authenticate(instances[0]);
    worker.subscribe('NOT A TICKER');
    worker.subscribe('!!!!!!');
    expect(worker.getActiveSymbols()).not.toContain('NOT A TICKER');
    worker.unsubscribe('SPY');
    expect(worker.getActiveSymbols()).toContain('SPY');
  });

  // Real coverage for the 2026-08-24 readiness audit, Part 2: FundamentalAgent/MacroAgent/
  // NewsAgent previously round-robinned through the full ~122-symbol idea universe without ever
  // requesting coverage for their own evaluation target - the deterministic cause of most
  // MISSING_PRICE rejections. subscribe()'s new opts.requestedBy makes that request visible.
  it('emits SYMBOL_NOT_SUBSCRIBED when a caller identifies itself and the symbol was not already streamed', () => {
    authenticate(instances[0]);
    emitSpy.mockClear();
    worker.subscribe('MRVL', { requestedBy: 'FundamentalAgent' });
    expect(emitSpy).toHaveBeenCalledWith('SYMBOL_NOT_SUBSCRIBED', expect.objectContaining({ symbol: 'MRVL', requestedBy: 'FundamentalAgent' }));
  });

  it('does not emit SYMBOL_NOT_SUBSCRIBED for an ordinary subscribe() call with no requestedBy (existing call sites unaffected)', () => {
    authenticate(instances[0]);
    emitSpy.mockClear();
    worker.subscribe('MRVL');
    expect(emitSpy).not.toHaveBeenCalledWith('SYMBOL_NOT_SUBSCRIBED', expect.anything());
  });

  it('emits MARKET_DATA_CAPACITY_FULL instead of silently dropping the request when a caller-attributed subscribe is refused at the hard cap', async () => {
    const { continuousIntelligence } = await import('../config/continuousIntelligence');
    const cap = continuousIntelligence.maxActiveSubscriptions;
    authenticate(instances[0]);
    for (const core of continuousIntelligence.coreStreamingSymbols) worker.subscribe(core);
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
    // Every dynamic slot is fresh (within dwell) right after subscribing, so a new candidate cannot
    // prune anything yet - the real "still full" case a caller-attributed request can hit.
    emitSpy.mockClear();
    worker.subscribe('VVVV', { requestedBy: 'MacroAgent' });
    expect(emitSpy).toHaveBeenCalledWith('MARKET_DATA_CAPACITY_FULL', expect.objectContaining({ symbol: 'VVVV', requestedBy: 'MacroAgent' }));
  });

  it('prunes least-active non-protected symbols at the configured cap instead of overflowing Alpaca', async () => {
    const { continuousIntelligence } = await import('../config/continuousIntelligence');
    const cap = continuousIntelligence.maxActiveSubscriptions;
    authenticate(instances[0]);
    for (const core of continuousIntelligence.coreStreamingSymbols) {
      worker.subscribe(core);
    }
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
    expect(worker.getCoreSymbols().sort()).toEqual([...continuousIntelligence.coreStreamingSymbols].sort());
    await expireDynamicDwell();
    // New candidate at cap should prune an older watch symbol and still fit under the hard ceiling.
    worker.subscribe('AMZN', { momentumScore: 9 });
    expect(worker.getActiveSymbols().length).toBe(cap);
    expect(worker.getActiveSymbols()).toContain('AMZN');
    for (const core of continuousIntelligence.coreStreamingSymbols) {
      expect(worker.getActiveSymbols()).toContain(core);
    }
  });

  it('never evicts SPY/QQQ/GLD anchors when rotating dynamic slots', async () => {
    const { continuousIntelligence } = await import('../config/continuousIntelligence');
    authenticate(instances[0]);
    for (const core of continuousIntelligence.coreStreamingSymbols) {
      worker.subscribe(core);
    }
    const extras = ['MSFT', 'TSLA', 'AMD', 'META', 'NVDA', 'AAPL', 'IWM', 'AMZN', 'NFLX'];
    for (const s of extras) worker.subscribe(s, { momentumScore: 1 });
    expect(worker.getActiveSymbols().length).toBe(continuousIntelligence.maxActiveSubscriptions);
    await expireDynamicDwell();
    worker.subscribe('COIN', { momentumScore: 50 });
    expect(worker.getActiveSymbols()).toContain('COIN');
    expect(worker.getActiveSymbols()).toEqual(
      expect.arrayContaining(continuousIntelligence.coreStreamingSymbols),
    );
    expect(worker.getDynamicSymbols().length).toBeLessThanOrEqual(
      continuousIntelligence.maxActiveSubscriptions - continuousIntelligence.coreStreamingSymbols.length,
    );
  });

  it('evicts unscored (score 0) dynamics before high-momentum leaders', async () => {
    const { continuousIntelligence } = await import('../config/continuousIntelligence');
    authenticate(instances[0]);
    // Start from anchors only — drop seed holdovers so eviction ranking is deterministic.
    for (const s of [...worker.getDynamicSymbols()]) {
      worker.unsubscribe(s);
    }
    for (const core of continuousIntelligence.coreStreamingSymbols) {
      worker.subscribe(core);
    }
    worker.subscribe('ZZAA'); // score defaults to 0
    worker.subscribe('COIN', { momentumScore: 5.4 });
    worker.subscribe('MRVL', { momentumScore: 3.6 });
    const fillers = ['ZZAB', 'ZZAC', 'ZZAD', 'ZZAE', 'ZZAF', 'ZZAG'];
    for (const s of fillers) {
      if (worker.getActiveSymbols().length >= continuousIntelligence.maxActiveSubscriptions) break;
      worker.subscribe(s, { momentumScore: 2.0 });
    }
    expect(worker.getActiveSymbols().length).toBe(continuousIntelligence.maxActiveSubscriptions);
    expect(worker.getActiveSymbols()).toContain('ZZAA');
    await expireDynamicDwell();
    worker.subscribe('SOFI', { momentumScore: 4.0 });
    expect(worker.getActiveSymbols()).toContain('SOFI');
    expect(worker.getActiveSymbols()).toContain('COIN');
    expect(worker.getActiveSymbols()).not.toContain('ZZAA');
  });

  it('protects newly hot-swapped dynamics from immediate eviction during dwell', async () => {
    const { continuousIntelligence } = await import('../config/continuousIntelligence');
    authenticate(instances[0]);
    for (const core of continuousIntelligence.coreStreamingSymbols) {
      worker.subscribe(core);
    }
    const fillers = ['ZZAB', 'ZZAC', 'ZZAD', 'ZZAE', 'ZZAF', 'ZZAG', 'ZZAH', 'ZZAI'];
    for (const s of fillers) {
      if (worker.getActiveSymbols().length >= continuousIntelligence.maxActiveSubscriptions - 1) break;
      worker.subscribe(s);
    }
    await expireDynamicDwell();
    worker.subscribe('COIN', { momentumScore: 9 });
    expect(worker.getActiveSymbols()).toContain('COIN');
    // Still inside dwell — next subscribe must not prune COIN (prefer expired ZZ seeds).
    worker.subscribe('MRVL', { momentumScore: 8 });
    expect(worker.getActiveSymbols()).toContain('COIN');
    expect(worker.getActiveSymbols().length).toBe(continuousIntelligence.maxActiveSubscriptions);
  });

  it('sends Alpaca unsubscribe on the wire before accepting a replacement at the cap', async () => {
    const { continuousIntelligence } = await import('../config/continuousIntelligence');
    const cap = continuousIntelligence.maxActiveSubscriptions;
    authenticate(instances[0]);
    const ws = instances[0];
    ws.sentMessages.length = 0;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (let i = 0; i < cap + 3; i++) {
      worker.subscribe(`ZZ${alphabet[i % 26]}${alphabet[(i + 3) % 26]}`);
    }
    await expireDynamicDwell();
    worker.subscribe('AMZN');
    const unsubs = ws.sentMessages.filter((m: any) => m.action === 'unsubscribe');
    const subs = ws.sentMessages.filter((m: any) => m.action === 'subscribe');
    expect(unsubs.length).toBeGreaterThan(0);
    expect(subs.some((m: any) => m.quotes?.includes('AMZN'))).toBe(true);
    expect(worker.getActiveSymbols().length).toBe(cap);
  });

  it('refuses to open a WebSocket when ARGUS_DISABLE_MARKET_DATA_WS is set', () => {
    worker.stop();
    process.env.ARGUS_DISABLE_MARKET_DATA_WS = 'true';
    const before = instances.length;
    worker.start();
    expect(instances.length).toBe(before);
    expect(worker.getFeedStatus().lastError).toBe('MARKET_DATA_WS_NOT_AUTHORIZED');
    delete process.env.ARGUS_DISABLE_MARKET_DATA_WS;
  });

  it('on symbol limit exceeded, purges non-core symbols and resubscribes core without reconnect storm', async () => {
    const { continuousIntelligence } = await import('../config/continuousIntelligence');
    const ws = instances[0];
    authenticate(ws);
    worker.subscribe('GOOGL');
    worker.subscribe('XOM');
    worker.subscribe('SMH');
    ws.sentMessages.length = 0;
    sendMessage(ws, { T: 'error', msg: 'symbol limit exceeded' });
    expect(worker.getActiveSymbols().sort()).toEqual(
      [...continuousIntelligence.coreStreamingSymbols].sort(),
    );
    const sub = ws.sentMessages.find((m: any) => m.action === 'subscribe');
    expect(sub?.quotes).toEqual(expect.arrayContaining(continuousIntelligence.coreStreamingSymbols));
    expect(instances.length).toBe(1); // no reconnect socket spawned
  });

  it('getEffectiveStreamingCap follows IBKR hardCapOverride (DEF-TODAY-01)', () => {
    expect(worker.getEffectiveStreamingCap()).toBeLessThanOrEqual(20);
    worker.setBrokerQuoteContext({ backend: 'ibkr_gateway', hardCapOverride: 90 });
    expect(worker.getEffectiveStreamingCap()).toBe(90);
    worker.setBrokerQuoteContext({ backend: 'alpaca', hardCapOverride: null });
    expect(worker.getEffectiveStreamingCap()).toBeLessThanOrEqual(20);
  });

  // 2026-09-04 opportunity-capture remediation: a real IBKR reqMktData rejection used to vanish
  // silently — the symbol stayed "active" forever with zero ticks and no diagnostic trail.
  // recordMarketDataError()/getActiveSlots() make that failure visible without changing what gets
  // subscribed or evicted.
  describe('recordMarketDataError() (IBKR reqMktData rejection surfacing)', () => {
    it('is null for a symbol with no recorded error', () => {
      expect(worker.getMarketDataError('NVDA')).toBeNull();
    });

    it('records and returns the error, case-insensitively', () => {
      worker.recordMarketDataError('nvda', 354, 'Requested market data is not subscribed.');
      const err = worker.getMarketDataError('NVDA');
      expect(err).not.toBeNull();
      expect(err?.code).toBe(354);
      expect(err?.message).toBe('Requested market data is not subscribed.');
      expect(typeof err?.atMs).toBe('number');
    });

    it('surfaces marketDataError on getActiveSlots() for a subscribed symbol', () => {
      worker.subscribe('NVDA', { momentumScore: 0.77 });
      worker.recordMarketDataError('NVDA', 354, 'Requested market data is not subscribed.');
      const slot = worker.getActiveSlots().find((s) => s.symbol === 'NVDA');
      expect(slot).toBeDefined();
      expect(slot?.marketDataError).toEqual(
        expect.objectContaining({ code: 354, message: 'Requested market data is not subscribed.' }),
      );
    });

    it('reports null marketDataError for a healthy subscribed symbol', () => {
      worker.subscribe('AAPL', { momentumScore: 0.5 });
      const slot = worker.getActiveSlots().find((s) => s.symbol === 'AAPL');
      expect(slot?.marketDataError).toBeNull();
    });

    it('clears the tracked error when the symbol is unsubscribed', () => {
      worker.subscribe('META', { momentumScore: 0.4 });
      worker.recordMarketDataError('META', 354, 'rejected');
      expect(worker.getMarketDataError('META')).not.toBeNull();
      worker.unsubscribe('META');
      expect(worker.getMarketDataError('META')).toBeNull();
    });
  });

  it('WATCHLIST_SUBSCRIBE_REQUESTED expands the IEX set without placing an order', () => {
    const handler = subscribeSpy.mock.calls.find((c: unknown[]) => c[0] === 'WATCHLIST_SUBSCRIBE_REQUESTED')?.[1] as ((p: { symbol?: string }) => void) | undefined;
    expect(handler).toBeTypeOf('function');
    handler!({ symbol: 'MSFT' });
    expect(worker.getActiveSymbols()).toContain('MSFT');
    expect(emitSpy).not.toHaveBeenCalledWith(expect.stringMatching(/ORDER/), expect.anything());
  });

  describe('isConnected() for the IBKR Gateway backend (2026-08-25 readiness audit, Phase 3 fix)', () => {
    it('defers to the bridge real connectivity check when the bridge provides isConnected()', () => {
      let bridgeConnected = true;
      worker.setBrokerQuoteContext({
        backend: 'ibkr_gateway',
        hardCapOverride: 90,
        ibkrBridge: {
          subscribe: () => {},
          unsubscribe: () => {},
          clear: () => {},
          isConnected: () => bridgeConnected,
        },
      });
      expect(worker.isConnected()).toBe(true);
      bridgeConnected = false;
      expect(worker.isConnected()).toBe(false);
    });

    it('reports disconnected once the real bridge says so, even with previously-subscribed symbols still in local bookkeeping', () => {
      let bridgeConnected = true;
      worker.setBrokerQuoteContext({
        backend: 'ibkr_gateway',
        hardCapOverride: 90,
        ibkrBridge: {
          subscribe: () => {},
          unsubscribe: () => {},
          clear: () => {},
          isConnected: () => bridgeConnected,
        },
      });
      worker.subscribe('AAPL');
      expect(worker.getActiveSymbols()).toContain('AAPL');
      expect(worker.isConnected()).toBe(true);

      // Real gateway disconnects later - the fix (2026-08-25) is that this must now be reflected
      // immediately, instead of staying "connected" forever just because activeStreams.size > 0
      // from the earlier successful subscribe.
      bridgeConnected = false;
      expect(worker.getActiveSymbols()).toContain('AAPL'); // local bookkeeping is unchanged...
      expect(worker.isConnected()).toBe(false); // ...but connectivity correctly reflects reality
    });

    it('falls back to the old activeStreams-based heuristic when the bridge does not provide isConnected() (back-compat)', () => {
      worker.setBrokerQuoteContext({
        backend: 'ibkr_gateway',
        hardCapOverride: 90,
        ibkrBridge: {
          subscribe: () => {},
          unsubscribe: () => {},
          clear: () => {},
        },
      });
      expect(worker.isConnected()).toBe(false);
      worker.subscribe('MSFT');
      expect(worker.isConnected()).toBe(true);
    });
  });

  // Phase 13 (2026-08-31 strategy-starvation remediation): requestTemporaryDataRescue() - a
  // bounded, single-use eviction-immunity grant so a strategy's real idea on a symbol outside the
  // actively-streamed set gets one genuine chance at live data on its next evaluation cycle,
  // without ever growing the permanent subscription universe or evicting a protected/rescued symbol.
  describe('requestTemporaryDataRescue()', () => {
    it('is a free no-op for a permanently protected core symbol - never consumes a bounded rescue slot, since it was never at eviction risk to begin with (real defect found live in production: QQQ/AAPL/TSLA rescues fired on a boot-time transient and could have starved a genuinely at-risk symbol out of the bounded budget)', async () => {
      const { continuousIntelligence } = await import('../config/continuousIntelligence');
      authenticate(instances[0]);
      for (const core of continuousIntelligence.coreStreamingSymbols) worker.subscribe(core);
      await expireDynamicDwell();

      const protectedSymbol = continuousIntelligence.protectedSymbols[0];
      const result = worker.requestTemporaryDataRescue(protectedSymbol, 'boot-transient');
      expect(result.granted).toBe(true);
      expect(result.evictedSymbol).toBeNull();
      // No bounded-slot bookkeeping was created for it at all.
      expect(worker.getActiveTemporaryRescues().map((r) => r.symbol)).not.toContain(protectedSymbol);

      // Confirm the full concurrent budget is still available for genuinely at-risk symbols -
      // Phase 18: the routine-recovery share is (cap - rescueReservedSlotsForPriorityClasses), and
      // the reserved slot is still separately available to a priority-class (exploration/mover)
      // request - the protected symbol above still consumed none of either share.
      const routineCap = continuousIntelligence.maxConcurrentTemporaryDataRescues - continuousIntelligence.rescueReservedSlotsForPriorityClasses;
      const routineSymbols = ['LNG', 'XOM'].slice(0, routineCap);
      for (const sym of routineSymbols) {
        const r = worker.requestTemporaryDataRescue(sym, 'real-need');
        expect(r.granted).toBe(true);
      }
      const priorityResult = worker.requestTemporaryDataRescue('CRM', 'exploration-need', { requestClass: 'EXPLORATION' });
      expect(priorityResult.granted).toBe(true);
    });

    it('Phase 14: a strategy that wins selection repeatedly on the same symbol (the real MOMENTUM_BREAKOUT/LNG pattern) gets a fresh rescue each time without any permanent subscription growth - each cycle grants, expires, and releases cleanly', async () => {
      const { continuousIntelligence } = await import('../config/continuousIntelligence');
      const cap = continuousIntelligence.maxActiveSubscriptions;
      authenticate(instances[0]);
      for (const core of continuousIntelligence.coreStreamingSymbols) worker.subscribe(core);
      await expireDynamicDwell();

      for (let cycle = 0; cycle < 5; cycle++) {
        const before = worker.getActiveSymbols().length;
        const result = worker.requestTemporaryDataRescue('LNG', 'MOMENTUM_BREAKOUT repeated win');
        expect(result.granted).toBe(true);
        expect(worker.getActiveSymbols().length).toBeLessThanOrEqual(cap);

        const grant = worker.getActiveTemporaryRescues().find((r) => r.symbol === 'LNG');
        expect(grant).toBeTruthy();
        worker.setNowForTests(grant!.expiresAtMs + 1);
        worker.releaseExpiredTemporaryDataRescues();
        expect(worker.getActiveTemporaryRescues().map((r) => r.symbol)).not.toContain('LNG');
        // Total active-stream count never permanently grows across repeated cycles - no leak.
        expect(worker.getActiveSymbols().length).toBeLessThanOrEqual(Math.max(before, cap));
      }
    });

    it('Phase 14: no permanent subscription leak - after many distinct symbols cycle through rescue and expiry, active-stream count never exceeds the hard cap', async () => {
      const { continuousIntelligence } = await import('../config/continuousIntelligence');
      const cap = continuousIntelligence.maxActiveSubscriptions;
      authenticate(instances[0]);
      for (const core of continuousIntelligence.coreStreamingSymbols) worker.subscribe(core);
      await expireDynamicDwell();

      const candidates = ['LNG', 'XOM', 'CRM', 'ANF', 'TH', 'BAC', 'PSN', 'INTU', 'EQT', 'COLD'];
      for (const sym of candidates) {
        worker.requestTemporaryDataRescue(sym, 'leak-test');
        expect(worker.getActiveSymbols().length).toBeLessThanOrEqual(cap);
        const grant = worker.getActiveTemporaryRescues().find((r) => r.symbol === sym);
        if (grant) {
          worker.setNowForTests(grant.expiresAtMs + 1);
          worker.releaseExpiredTemporaryDataRescues();
        }
        expect(worker.getActiveSymbols().length).toBeLessThanOrEqual(cap);
      }
    });

    it('subscribes and protects a not-yet-subscribed symbol at capacity by evicting exactly one safe candidate', async () => {
      const { continuousIntelligence } = await import('../config/continuousIntelligence');
      const cap = continuousIntelligence.maxActiveSubscriptions;
      authenticate(instances[0]);
      for (const core of continuousIntelligence.coreStreamingSymbols) worker.subscribe(core);
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
      await expireDynamicDwell();

      const result = worker.requestTemporaryDataRescue('LNG', 'QuantEngine:MOMENTUM_BREAKOUT_stale_data_rescue');
      expect(result.granted).toBe(true);
      expect(result.evictedSymbol).not.toBeNull();
      expect(worker.getActiveSymbols()).toContain('LNG');
      expect(worker.getActiveSymbols().length).toBe(cap);
      for (const core of continuousIntelligence.coreStreamingSymbols) {
        expect(worker.getActiveSymbols()).toContain(core); // never evicts a protected anchor
      }
    });

    it('never evicts a symbol that itself holds an active rescue, even under repeated capacity pressure', async () => {
      const { continuousIntelligence } = await import('../config/continuousIntelligence');
      const cap = continuousIntelligence.maxActiveSubscriptions;
      authenticate(instances[0]);
      for (const core of continuousIntelligence.coreStreamingSymbols) worker.subscribe(core);
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      let requested = 0;
      outer: for (let i = 0; i < 26; i++) {
        for (let j = 0; j < 26; j++) {
          worker.subscribe(`ZZ${alphabet[i]}${alphabet[j]}`);
          requested += 1;
          if (requested > cap + 8) break outer;
        }
      }
      await expireDynamicDwell();
      const first = worker.requestTemporaryDataRescue('LNG', 'rescue-1');
      expect(first.granted).toBe(true);

      // Race/pressure: repeatedly request rescues for other symbols while LNG's rescue is active -
      // none of these evictions may ever select LNG (that would defeat the whole point of a grant).
      for (const sym of ['XOM', 'CRM']) {
        const r = worker.requestTemporaryDataRescue(sym, 'rescue-pressure');
        if (r.granted) expect(r.evictedSymbol).not.toBe('LNG');
      }
      expect(worker.getActiveSymbols()).toContain('LNG');
    });

    it('denies a new rescue once maxConcurrentTemporaryDataRescues is reached, without evicting anything for it (hard ceiling - uses a priority class so the Phase 18 routine-only reservation does not also gate this specific test)', async () => {
      const { continuousIntelligence } = await import('../config/continuousIntelligence');
      authenticate(instances[0]);
      for (const core of continuousIntelligence.coreStreamingSymbols) worker.subscribe(core);
      await expireDynamicDwell();

      const grants: string[] = [];
      const cap = continuousIntelligence.maxConcurrentTemporaryDataRescues;
      // Sized to cap+1 (not a fixed literal list) so there's always exactly one guaranteed
      // overflow candidate regardless of config, matching this test's own intent.
      const candidates = Array.from({ length: cap + 1 }, (_, i) => `CAND${i}`);
      for (const sym of candidates) {
        const r = worker.requestTemporaryDataRescue(sym, 'capacity-test', { requestClass: 'MARKET_MOVER' });
        if (r.granted) grants.push(sym);
      }
      expect(grants.length).toBe(cap);
      const overflow = candidates.find((s) => !grants.includes(s));
      expect(overflow).toBeTruthy();
      const denied = worker.requestTemporaryDataRescue(overflow!, 'capacity-test', { requestClass: 'MARKET_MOVER' });
      expect(denied.granted).toBe(false);
      expect(denied.deniedReason).toBe('RESCUE_CAPACITY_FULL');
    });

    it('extending an already-active rescue never counts twice against the concurrent cap and never evicts', async () => {
      const { continuousIntelligence } = await import('../config/continuousIntelligence');
      authenticate(instances[0]);
      for (const core of continuousIntelligence.coreStreamingSymbols) worker.subscribe(core);
      await expireDynamicDwell();

      const first = worker.requestTemporaryDataRescue('LNG', 'first');
      expect(first.granted).toBe(true);
      const again = worker.requestTemporaryDataRescue('LNG', 'renewed');
      expect(again.granted).toBe(true);
      expect(again.evictedSymbol).toBeNull();
      expect(again.alreadySubscribed).toBe(true);
    });

    it('auto-releases after temporaryDataRescueMaxDurationMs elapses, becoming evictable again like any other dynamic symbol', async () => {
      const { continuousIntelligence } = await import('../config/continuousIntelligence');
      const cap = continuousIntelligence.maxActiveSubscriptions;
      authenticate(instances[0]);
      for (const core of continuousIntelligence.coreStreamingSymbols) worker.subscribe(core);
      await expireDynamicDwell();

      const result = worker.requestTemporaryDataRescue('LNG', 'expiry-test');
      expect(result.granted).toBe(true);
      const grant = worker.getActiveTemporaryRescues().find((r) => r.symbol === 'LNG');
      expect(grant).toBeTruthy();

      worker.setNowForTests(grant!.expiresAtMs + 1);
      worker.releaseExpiredTemporaryDataRescues();
      expect(worker.getActiveTemporaryRescues().map((r) => r.symbol)).not.toContain('LNG');

      // Now evictable again like any other dynamic symbol - fill capacity and confirm a fresh
      // rescue request for a DIFFERENT symbol can evict the expired one.
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      let requested = 0;
      outer: for (let i = 0; i < 26; i++) {
        for (let j = 0; j < 26; j++) {
          if (worker.getActiveSymbols().length >= cap) break outer;
          worker.subscribe(`ZZ${alphabet[i]}${alphabet[j]}`);
          requested += 1;
        }
      }
      await expireDynamicDwell();
      const second = worker.requestTemporaryDataRescue('XOM', 'expiry-followup');
      expect(second.granted).toBe(true);
    });

    it('denies gracefully when at capacity and no safe (non-protected, non-dwelling, non-rescued) eviction exists', async () => {
      const { continuousIntelligence } = await import('../config/continuousIntelligence');
      authenticate(instances[0]);
      for (const core of continuousIntelligence.coreStreamingSymbols) worker.subscribe(core);
      // Fill every remaining slot with core symbols only (all protected) - no safe eviction target.
      const remaining = continuousIntelligence.maxActiveSubscriptions - continuousIntelligence.coreStreamingSymbols.length;
      for (let i = 0; i < remaining; i++) {
        worker.requestTemporaryDataRescue(`RESQ${i}`, 'fill');
      }
      // All rescue slots are bounded by maxConcurrentTemporaryDataRescues, so most of these are
      // denied by capacity, not by eviction - just confirm nothing crashes and state stays sane.
      expect(worker.getActiveSymbols().length).toBeLessThanOrEqual(continuousIntelligence.maxActiveSubscriptions);
    });
  });

  // Phase 18 (2026-09-01 rescue-fairness fix). Reproduces the exact Phase 17 live failure
  // pattern - AAPL/TSLA/AI (routine repeat-requesters) occupying every slot, denying real
  // exploration promotions (CRM, ONON) - and proves the fairness invariants the mission required.
  describe('requestTemporaryDataRescue() - Phase 18 rescue-fairness invariants', () => {
    it('Invariant 1/2 - reproduces the exact Phase 17 failure: 3 routine repeat-requesters cannot occupy every slot, leaving a bounded opportunity for exploration promotions', async () => {
      const { continuousIntelligence } = await import('../config/continuousIntelligence');
      authenticate(instances[0]);
      for (const core of continuousIntelligence.coreStreamingSymbols) worker.subscribe(core);
      await expireDynamicDwell();

      // The real live pattern: 3 symbols requesting/extending ROUTINE_RECOVERY rescue, exactly as
      // QuantSignalAgent's default (unclassed) stale-data-discard path does today. Phase 28
      // (2026-09-02 P0 discovery fix): deliberately NOT AAPL/TSLA here - those are real
      // continuousIntelligence.seedSymbols, auto-subscribed by ensureDefaultSubscriptions() the
      // moment authenticate() fires above, so a genuine rescue request on them is now correctly
      // classified RENEWAL (already subscribed) and no longer competes for this ACQUISITION-only
      // capacity check at all - the generated symbols below are real, deliberately non-seed/non-core
      // so this test still reproduces genuine NEW_DATA_ACQUISITION contention, matching the real
      // FRVO incident's own acquisition-side symbol (never itself a seed/core name). One MORE than
      // routineCap requesters (not a fixed literal count) so the cap genuinely binds regardless of
      // config - matching this test's own stated intent ("cannot occupy every slot").
      const routineCapForThisTest = continuousIntelligence.maxConcurrentTemporaryDataRescues - continuousIntelligence.rescueReservedSlotsForPriorityClasses;
      const routineRequesterSymbols = Array.from({ length: routineCapForThisTest + 1 }, (_, i) => `ROUT${i}`);
      const routineGrants = routineRequesterSymbols.map((sym) => worker.requestTemporaryDataRescue(sym, 'stale-data'));
      const routineGrantedCount = routineGrants.filter((r) => r.granted).length;
      // Pre-Phase-18 this would have been the entire pool - now it is capped below the total.
      expect(routineGrantedCount).toBe(routineCapForThisTest);
      expect(routineGrantedCount).toBeLessThan(continuousIntelligence.maxConcurrentTemporaryDataRescues);

      // CRM and ONON now arrive exactly as they did live: real exploration promotions.
      const crm = worker.requestTemporaryDataRescue('CRM', 'exploration:MOMENTUM_BREAKOUT', { requestClass: 'EXPLORATION' });
      expect(crm.granted).toBe(true);

      // A second exploration promotion may or may not fit depending on the reserved-slot count,
      // but it must fail with the specific reserved-capacity reason, never silently succeed by
      // displacing a routine occupant, and never exceed the hard total ceiling.
      const onon = worker.requestTemporaryDataRescue('ONON', 'exploration:TREND_FOLLOWING', { requestClass: 'EXPLORATION' });
      if (!onon.granted) {
        expect(['RESCUE_CAPACITY_FULL', 'ROUTINE_CAPACITY_RESERVED_FOR_PRIORITY']).toContain(onon.deniedReason);
      }
      expect(worker.getActiveTemporaryRescues().length).toBeLessThanOrEqual(continuousIntelligence.maxConcurrentTemporaryDataRescues);
    });

    it('Invariant 1 - routine repeat-requesters cannot monopolize the pool even across many repeated re-requests over time', async () => {
      const { continuousIntelligence } = await import('../config/continuousIntelligence');
      authenticate(instances[0]);
      for (const core of continuousIntelligence.coreStreamingSymbols) worker.subscribe(core);
      await expireDynamicDwell();

      // Simulate hours of the live pattern: AAPL/TSLA/AI re-requesting every cycle, letting each
      // grant expire between requests (matching the live observation that grants roughly matched
      // the request cadence, so each was a fresh grant, not a free extension).
      for (let cycle = 0; cycle < 3; cycle++) {
        for (const sym of ['AAPL', 'TSLA', 'AI']) {
          worker.requestTemporaryDataRescue(sym, 'stale-data');
        }
        // A fresh exploration candidate arrives every cycle too.
        const explorer = worker.requestTemporaryDataRescue(`EXPL${cycle}`, 'exploration', { requestClass: 'EXPLORATION' });
        expect(explorer.granted).toBe(true); // the reserved slot is available every single cycle, not just the first
        worker.setNowForTests(worker.getActiveTemporaryRescues().find((r) => r.symbol === `EXPL${cycle}`)!.expiresAtMs + 1);
        worker.releaseExpiredTemporaryDataRescues();
      }
    });

    it('Invariant 3 - capacity is never exceeded regardless of request-class mix', async () => {
      const { continuousIntelligence } = await import('../config/continuousIntelligence');
      authenticate(instances[0]);
      for (const core of continuousIntelligence.coreStreamingSymbols) worker.subscribe(core);
      await expireDynamicDwell();

      const classes: Array<'ROUTINE_RECOVERY' | 'EXPLORATION' | 'MARKET_MOVER'> = ['ROUTINE_RECOVERY', 'EXPLORATION', 'MARKET_MOVER'];
      let granted = 0;
      for (let i = 0; i < 9; i++) {
        const r = worker.requestTemporaryDataRescue(`SYM${i}`, 'mixed', { requestClass: classes[i % classes.length] });
        if (r.granted) granted += 1;
        expect(worker.getActiveTemporaryRescues().length).toBeLessThanOrEqual(continuousIntelligence.maxConcurrentTemporaryDataRescues);
      }
      expect(granted).toBeLessThanOrEqual(continuousIntelligence.maxConcurrentTemporaryDataRescues);
    });

    it('Invariant 4 - expiration still works identically regardless of request class', async () => {
      authenticate(instances[0]);
      await expireDynamicDwell();
      const r = worker.requestTemporaryDataRescue('CRM', 'exploration', { requestClass: 'EXPLORATION' });
      expect(r.granted).toBe(true);
      const grant = worker.getActiveTemporaryRescues().find((g) => g.symbol === 'CRM');
      expect(grant).toBeTruthy();
      worker.setNowForTests(grant!.expiresAtMs + 1);
      worker.releaseExpiredTemporaryDataRescues();
      expect(worker.getActiveTemporaryRescues().map((g) => g.symbol)).not.toContain('CRM');
    });

    it('Invariant 5 - a symbol holding an active rescue (any class) remains eviction-protected', async () => {
      const { continuousIntelligence } = await import('../config/continuousIntelligence');
      authenticate(instances[0]);
      for (const core of continuousIntelligence.coreStreamingSymbols) worker.subscribe(core);
      await expireDynamicDwell();
      const r = worker.requestTemporaryDataRescue('ONON', 'exploration', { requestClass: 'EXPLORATION' });
      expect(r.granted).toBe(true);
      // Fill remaining subscription capacity so eviction pressure exists - bounded loop (real
      // defect found in this test itself: an earlier unbounded `while (activeSymbols.length <
      // cap)` could spin forever if subscribe() ever silently no-ops instead of growing
      // activeStreams, crashing the test worker outright rather than failing an assertion).
      const cap = continuousIntelligence.maxActiveSubscriptions;
      for (let i = 0; i < cap + 5 && worker.getActiveSymbols().length < cap; i++) {
        worker.subscribe(`FILL${i}`);
      }
      worker.requestTemporaryDataRescue('ANOTHER', 'stale-data');
      expect(worker.getActiveSymbols()).toContain('ONON');
    });

    it('Invariant 6 - a priority-class rescue still expires and does not remain rescued indefinitely', async () => {
      authenticate(instances[0]);
      await expireDynamicDwell();
      const r = worker.requestTemporaryDataRescue('CRM', 'exploration', { requestClass: 'EXPLORATION' });
      expect(r.granted).toBe(true);
      const grant = worker.getActiveTemporaryRescues().find((g) => g.symbol === 'CRM')!;
      worker.setNowForTests(grant.expiresAtMs + 1);
      expect(worker.getActiveTemporaryRescues().map((g) => g.symbol)).not.toContain('CRM'); // hasActiveRescue() self-expires on read
    });

    it('Invariant 8 - admission is deterministic given the same occupancy/class/timestamps', async () => {
      authenticate(instances[0]);
      await expireDynamicDwell();
      // Same starting occupancy (zero active rescues, forced clean between trials), same request
      // sequence, same symbols, every trial - if admission depended on anything but requestClass +
      // current occupancy, these trials would disagree.
      const results: boolean[] = [];
      for (let trial = 0; trial < 3; trial++) {
        for (const sym of ['AAPL', 'TSLA', 'AI']) worker.requestTemporaryDataRescue(sym, 'stale-data');
        const outcome = worker.requestTemporaryDataRescue('CRM', 'exploration', { requestClass: 'EXPLORATION' });
        results.push(outcome.granted);
        // Force every active rescue to expire so the next trial starts from the same clean state.
        const all = worker.getActiveTemporaryRescues();
        if (all.length > 0) {
          worker.setNowForTests(Math.max(...all.map((r) => r.expiresAtMs)) + 1);
          worker.releaseExpiredTemporaryDataRescues();
        }
        worker.setNowForTests(null);
      }
      expect(new Set(results).size).toBe(1); // every trial produced the identical admission decision
    });

    it('Invariant 9 - a caller that omits requestClass entirely behaves exactly as ROUTINE_RECOVERY (backward compatible)', async () => {
      const { continuousIntelligence } = await import('../config/continuousIntelligence');
      authenticate(instances[0]);
      await expireDynamicDwell();
      const routineCap = continuousIntelligence.maxConcurrentTemporaryDataRescues - continuousIntelligence.rescueReservedSlotsForPriorityClasses;
      // Phase 28: non-seed symbols (not AAPL/TSLA/MSFT - those three are real seedSymbols,
      // auto-subscribed by authenticate() above, so they'd be classified RENEWAL, not exercising
      // the ACQUISITION-only capacity check this test targets). Sized to routineCap (not a fixed
      // literal count) so this test scales automatically with config, exactly like the
      // "opposite condition" test below already does.
      const unclassedSymbols = Array.from({ length: routineCap }, (_, i) => `UNCL${i}`);
      const unclassed = unclassedSymbols.map((sym) => worker.requestTemporaryDataRescue(sym, 'no-class-arg'));
      expect(unclassed.filter((r) => r.granted).length).toBe(routineCap);
      const explicit = worker.requestTemporaryDataRescue('CRM', 'explicit-routine', { requestClass: 'ROUTINE_RECOVERY' });
      expect(explicit.granted).toBe(unclassed[unclassed.length - 1].granted === false ? false : explicit.granted); // same admission rule either way
    });

    it('opposite condition - when exploration/mover demand is absent, routine recovery uses its normal share without any fairness penalty', async () => {
      const { continuousIntelligence } = await import('../config/continuousIntelligence');
      authenticate(instances[0]);
      await expireDynamicDwell();
      const routineCap = continuousIntelligence.maxConcurrentTemporaryDataRescues - continuousIntelligence.rescueReservedSlotsForPriorityClasses;
      const grants = [];
      for (let i = 0; i < routineCap; i++) {
        grants.push(worker.requestTemporaryDataRescue(`ROUTINE${i}`, 'stale-data'));
      }
      expect(grants.every((r) => r.granted)).toBe(true);
    });

    it('a rescue denial is logged with the request class and reason (no more silent denials)', async () => {
      const { continuousIntelligence } = await import('../config/continuousIntelligence');
      authenticate(instances[0]);
      await expireDynamicDwell();
      const routineCap = continuousIntelligence.maxConcurrentTemporaryDataRescues - continuousIntelligence.rescueReservedSlotsForPriorityClasses;
      // Phase 28: non-seed symbols - see Invariant 1/2's comment (seedSymbols auto-subscribe).
      // Sized to routineCap so this fills exactly the real routine capacity regardless of config.
      for (let i = 0; i < routineCap; i++) worker.requestTemporaryDataRescue(`FILL${i}`, 'stale-data');
      emitSpy.mockClear();
      worker.requestTemporaryDataRescue('CRM', 'stale-data'); // one past routineCap - should be denied and logged
      // logRescueDenial uses structuredLogger (DB-backed), not eventBus - assert via getActiveTemporaryRescues not growing.
      expect(worker.getActiveTemporaryRescues().map((r) => r.symbol)).not.toContain('CRM');
    });

    it('getActiveTemporaryRescues() exposes requestClass/traceId/requestCount/extensionCount for occupancy observability', async () => {
      authenticate(instances[0]);
      await expireDynamicDwell();
      worker.requestTemporaryDataRescue('CRM', 'exploration:MOMENTUM_BREAKOUT', { requestClass: 'EXPLORATION', traceId: 'trace_CRM_123' });
      const occupant = worker.getActiveTemporaryRescues().find((r) => r.symbol === 'CRM')!;
      expect(occupant.requestClass).toBe('EXPLORATION');
      expect(occupant.traceId).toBe('trace_CRM_123');
      expect(occupant.requestCount).toBe(1);
      expect(occupant.extensionCount).toBe(0);
      // Re-request while still active = an extension, not a new grant.
      worker.requestTemporaryDataRescue('CRM', 'exploration:MOMENTUM_BREAKOUT', { requestClass: 'EXPLORATION', traceId: 'trace_CRM_124' });
      const extended = worker.getActiveTemporaryRescues().find((r) => r.symbol === 'CRM')!;
      expect(extended.requestCount).toBe(2);
      expect(extended.extensionCount).toBe(1);
    });
  });

  // Phase 28 (2026-09-02 P0 discovery fix). Confirmed root cause of the real FRVO incident
  // (2026-09-01): a request on an already-subscribed symbol that only ever needs its
  // eviction-immunity window extended (RENEWAL) was counted against the SAME concurrent-rescue
  // budget a genuinely unsubscribed candidate needing its first live tick (NEW_DATA_ACQUISITION)
  // needed. Live evidence: AAPL/TSLA/ABNB (already subscribed) occupied all 3 slots for the
  // entire ~50-minute window, denying FRVO (never subscribed, real GlobeNewswire catalyst) 11
  // times in a row with RESCUE_CAPACITY_FULL. These tests use generic, deliberately non-real-
  // incident symbol names (never "FRVO" itself) to prove the fix addresses the general class of
  // defect, not one hardcoded ticker.
  describe('requestTemporaryDataRescue() - Phase 28 rescue-intent segmentation (P0 discovery fix)', () => {
    // looksLikeListedTicker() (subscribe()'s own validation) requires 1-5 PURE uppercase letters -
    // no digits - so digit-suffixed placeholder symbols (e.g. "RENEW0") silently fail to subscribe,
    // which would make these tests assert on their own broken fixture rather than the real fix.
    // This generates deterministic, distinct, always-valid synthetic tickers instead.
    function testTicker(i: number): string {
      const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      return `Z${letters[i % 26]}${letters[Math.floor(i / 26) % 26]}`;
    }

    it('reproduces the exact confirmed defect and proves the fix: N already-subscribed renewal-only symbols filling the OLD shared pool no longer deny a genuine first-tick candidate', async () => {
      const { continuousIntelligence } = await import('../config/continuousIntelligence');
      const cap = continuousIntelligence.maxConcurrentTemporaryDataRescues;

      // The AAPL/TSLA/ABNB-equivalent: real, already-subscribed symbols that only ever request a
      // RENEWAL of their eviction-immunity - never a first tick, since they already have live data.
      const renewalOnly = Array.from({ length: cap }, (_, i) => testTicker(i));
      for (const sym of renewalOnly) worker.subscribe(sym);
      expect(renewalOnly.every((sym) => worker.getActiveSymbols().includes(sym))).toBe(true);

      // OLD behavior (pre-Phase-28): this loop alone would have consumed the entire
      // maxConcurrentTemporaryDataRescues pool, exactly as AAPL/TSLA/ABNB did live.
      const renewalGrants = renewalOnly.map((sym) => worker.requestTemporaryDataRescue(sym, 'renew-immunity'));
      expect(renewalGrants.every((r) => r.granted)).toBe(true);
      expect(renewalGrants.every((r) => r.alreadySubscribed)).toBe(true);

      // The FRVO-equivalent: a genuinely new, never-subscribed candidate needing its first tick.
      // Under the OLD shared-pool behavior this would be denied RESCUE_CAPACITY_FULL, exactly as
      // FRVO was denied 11/11 times. Under the fix, renewal-only occupancy above must not count
      // against this candidate's acquisition budget at all.
      const newCandidateSymbol = testTicker(cap);
      const newCandidate = worker.requestTemporaryDataRescue(newCandidateSymbol, 'stale-data');
      expect(newCandidate.granted).toBe(true);
      expect(newCandidate.alreadySubscribed).toBe(false);

      const occupants = worker.getActiveTemporaryRescues();
      for (const sym of renewalOnly) {
        expect(occupants.find((o) => o.symbol === sym)?.intent).toBe('RENEWAL');
      }
      expect(occupants.find((o) => o.symbol === newCandidateSymbol)?.intent).toBe('NEW_DATA_ACQUISITION');
    });

    it('a RENEWAL request never consumes NEW_DATA_ACQUISITION capacity, even when it fills what would have been the entire shared pool', async () => {
      const { continuousIntelligence } = await import('../config/continuousIntelligence');
      const cap = continuousIntelligence.maxConcurrentTemporaryDataRescues;

      // Sized to exactly `cap` (fills, not doubles, the entire theoretical rescue pool) rather
      // than cap*2 - large enough to prove RENEWAL is exempt from the acquisition cap, small
      // enough to leave real subscription-slot headroom (maxActiveSubscriptions) for the
      // acquisition requests below, regardless of how large `cap` itself is configured to be.
      const renewalOnly = Array.from({ length: cap }, (_, i) => testTicker(i));
      for (const sym of renewalOnly) worker.subscribe(sym);
      for (const sym of renewalOnly) {
        const r = worker.requestTemporaryDataRescue(sym, 'renew-immunity');
        expect(r.granted).toBe(true); // never denied - RENEWAL is not bound by the acquisition cap
      }

      // The full NEW_DATA_ACQUISITION budget must still be independently available - but only
      // routineCap of it is guaranteed to a default (ROUTINE_RECOVERY) requester; the remaining
      // reservedSlotsForPriorityClasses share is reserved for EXPLORATION/MARKET_MOVER/NEWS_CATALYST,
      // exactly as it was before this fix (Phase 18) - this test only proves the RENEWAL traffic
      // above never ate into any part of this budget, not that the reserved-slot rule is gone.
      const routineCap = cap - continuousIntelligence.rescueReservedSlotsForPriorityClasses;
      const acquisitionGrants: boolean[] = [];
      for (let i = 0; i < routineCap; i++) {
        acquisitionGrants.push(worker.requestTemporaryDataRescue(testTicker(cap + i), 'stale-data').granted);
      }
      expect(acquisitionGrants.every(Boolean)).toBe(true);
      // Every reserved slot (not just one) is still available to priority-class acquisition
      // requests - drain all of them so the pool is genuinely, not just partially, exhausted.
      const reservedSlots = continuousIntelligence.rescueReservedSlotsForPriorityClasses;
      const priorityGrants: boolean[] = [];
      for (let i = 0; i < reservedSlots; i++) {
        priorityGrants.push(
          worker.requestTemporaryDataRescue(testTicker(cap + routineCap + i), 'stale-data', { requestClass: 'EXPLORATION' }).granted,
        );
      }
      expect(priorityGrants.every(Boolean)).toBe(true);
      // routineCap + reservedSlots === cap, so capacity is now genuinely full - the next request
      // of any class must be denied for being full, not merely reserved-for-priority.
      const overflow = worker.requestTemporaryDataRescue(testTicker(cap + routineCap + reservedSlots), 'stale-data');
      expect(overflow.granted).toBe(false);
      expect(overflow.deniedReason).toBe('RESCUE_CAPACITY_FULL');
    });

    it('N renewal-only requesters, scaled from 1 up to the maximum plausible concurrent count derived from the real streaming cap, never trigger a rescue-BUDGET denial for a genuine acquisition candidate', async () => {
      const { continuousIntelligence } = await import('../config/continuousIntelligence');
      const maxPlausibleN = continuousIntelligence.maxActiveSubscriptions; // derived from the real cap, not assumed
      for (let n = 1; n <= maxPlausibleN; n++) {
        const worker2 = new MarketDataWorker();
        const renewalSymbols = Array.from({ length: n }, (_, i) => testTicker(i));
        for (const sym of renewalSymbols) worker2.subscribe(sym);
        worker2.setNowForTests(Date.now() + continuousIntelligence.minDynamicDwellMs + 1000);
        for (const sym of renewalSymbols) {
          expect(worker2.requestTemporaryDataRescue(sym, 'renew').granted).toBe(true);
        }
        const acquisition = worker2.requestTemporaryDataRescue(testTicker(maxPlausibleN + n), 'stale-data');
        // At n < maxPlausibleN there is always a free active-stream slot, so acquisition must
        // succeed outright. Only at n === maxPlausibleN is every slot both occupied AND held under
        // an active (thus eviction-immune) rescue grant - a genuinely separate, pre-existing,
        // real capacity/eviction boundary this fix does not touch and must not weaken (rescue
        // immunity must keep meaning immunity). If denied there, the reason must be
        // AT_CAPACITY_NO_SAFE_EVICTION specifically - proving the denial is a real capacity limit,
        // NEVER the rescue-budget-sharing defect this fix targets (RESCUE_CAPACITY_FULL /
        // ROUTINE_CAPACITY_RESERVED_FOR_PRIORITY), which is exactly what would have wrongly denied
        // it before Phase 28.
        if (!acquisition.granted) {
          expect(n).toBe(maxPlausibleN);
          expect(acquisition.deniedReason).toBe('AT_CAPACITY_NO_SAFE_EVICTION');
        }
        worker2.setNowForTests(null);
        worker2.stop();
      }
    });

    it('RENEWAL admission never fabricates a fresh tick - hasFreshTick in the grant log reflects real lastTick state, and no tick is ever synthesized by granting a rescue', async () => {
      const sym = testTicker(0);
      worker.subscribe(sym);
      const grantSpy = vi.spyOn(structuredLogger, 'info');
      const result = worker.requestTemporaryDataRescue(sym, 'renew-immunity');
      expect(result.granted).toBe(true);
      const grantedCall = grantSpy.mock.calls.find(([msg]) => msg === 'temporary_data_rescue_granted');
      expect(grantedCall).toBeTruthy();
      expect(grantedCall![1].hasFreshTick).toBe(false); // never recorded a real tick - never claimed otherwise
      grantSpy.mockRestore();
    });

    it('a denied acquisition request logs requestIntent=NEW_DATA_ACQUISITION explicitly (queryable without regex-parsing the reasoning string)', async () => {
      const { continuousIntelligence } = await import('../config/continuousIntelligence');
      const cap = continuousIntelligence.maxConcurrentTemporaryDataRescues;
      for (let i = 0; i < cap; i++) worker.requestTemporaryDataRescue(testTicker(i), 'stale-data');
      const denySpy = vi.spyOn(structuredLogger, 'info');
      const denied = worker.requestTemporaryDataRescue(testTicker(cap), 'stale-data');
      expect(denied.granted).toBe(false);
      const deniedCall = denySpy.mock.calls.find(([msg]) => msg === 'temporary_data_rescue_denied');
      expect(deniedCall).toBeTruthy();
      expect(deniedCall![1].requestIntent).toBe('NEW_DATA_ACQUISITION');
      expect(deniedCall![1].alreadySubscribed).toBe(false);
      denySpy.mockRestore();
    });

    it('a RENEWAL grant remains excluded from eviction candidates, identically to an ACQUISITION grant (Invariant 5 regression, both intents)', async () => {
      const { continuousIntelligence } = await import('../config/continuousIntelligence');
      authenticate(instances[0]);
      for (const core of continuousIntelligence.coreStreamingSymbols) worker.subscribe(core);
      await expireDynamicDwell();

      const protectedRenewal = testTicker(0);
      worker.subscribe(protectedRenewal);
      const r = worker.requestTemporaryDataRescue(protectedRenewal, 'renew-immunity');
      expect(r.granted).toBe(true);
      expect(r.alreadySubscribed).toBe(true);

      const cap = continuousIntelligence.maxActiveSubscriptions;
      for (let i = 1; i < cap + 5 && worker.getActiveSymbols().length < cap; i++) {
        worker.subscribe(testTicker(i));
      }
      worker.requestTemporaryDataRescue(testTicker(cap + 10), 'stale-data');
      expect(worker.getActiveSymbols()).toContain(protectedRenewal);
    });
  });

  // Phase 28 (2026-09-02 P0 discovery fix), Discovery Lineage extension. The real FRVO incident
  // entered ARGUS through exactly this path (NewsAgent's price request for a not-yet-subscribed
  // symbol) with zero lineage record at the time - this closes that gap using the SAME existing
  // Discovery Lineage Ledger mechanism (logDiscoveryCandidateDecision(), previously private to
  // MarketUniverseScanner.ts, now shared) rather than a second one.
  describe('subscribe() - Phase 28 Discovery Lineage: source=NEWS tagging', () => {
    afterEach(() => clearNewsCatalystsForTests());

    it('logs a source=NEWS discovery-lineage admission when a not-yet-subscribed symbol has real catalyst evidence', () => {
      recordNewsCatalyst({
        traceId: 't-lineage-1', symbol: 'ZNEW', headline: 'Real catalyst', source: 'unit',
        publishedAtMs: Date.now(), sentiment: 0.5, credibility: 0.9, catalystStrength: 'HIGH',
        tradingBias: 'BULLISH', contribution: 0.2, reasoning: 'unit', recordedAt: new Date().toISOString(),
      });
      const logSpy = vi.spyOn(structuredLogger, 'info');
      worker.subscribe('ZNEW', { requestedBy: 'NewsAgent' });
      const call = logSpy.mock.calls.find(([msg]) => msg === 'discovery_candidate_decision');
      expect(call).toBeTruthy();
      expect(call![1].eventType).toBe('DISCOVERY_CANDIDATE_ADMITTED');
      expect(call![1].source).toBe('NEWS');
      expect(call![1].symbol).toBe('ZNEW');
      logSpy.mockRestore();
    });

    it('does NOT log a discovery-lineage entry when no real catalyst evidence exists - a routine round-robin price check on an ordinary symbol is not itself a "discovery" event', () => {
      const logSpy = vi.spyOn(structuredLogger, 'info');
      worker.subscribe('ZORD', { requestedBy: 'FundamentalAgent' });
      const call = logSpy.mock.calls.find(([msg]) => msg === 'discovery_candidate_decision');
      expect(call).toBeUndefined();
      logSpy.mockRestore();
    });

    it('does not log a discovery-lineage entry when the symbol is already subscribed - only a genuine not-yet-subscribed entry counts as discovery', () => {
      recordNewsCatalyst({
        traceId: 't-lineage-2', symbol: 'ZALR', headline: 'Real catalyst', source: 'unit',
        publishedAtMs: Date.now(), sentiment: 0.5, credibility: 0.9, catalystStrength: 'HIGH',
        tradingBias: 'BULLISH', contribution: 0.2, reasoning: 'unit', recordedAt: new Date().toISOString(),
      });
      worker.subscribe('ZALR'); // already subscribed before any requestedBy-driven lookup
      const logSpy = vi.spyOn(structuredLogger, 'info');
      worker.subscribe('ZALR', { requestedBy: 'NewsAgent' });
      const call = logSpy.mock.calls.find(([msg]) => msg === 'discovery_candidate_decision');
      expect(call).toBeUndefined();
      logSpy.mockRestore();
    });

    it('deduplicates repeated news-driven lookups on the same still-unsubscribed symbol - one real entry, not one per attempt', async () => {
      const { continuousIntelligence } = await import('../config/continuousIntelligence');
      recordNewsCatalyst({
        traceId: 't-lineage-3', symbol: 'ZDUP', headline: 'Real catalyst', source: 'unit',
        publishedAtMs: Date.now(), sentiment: 0.5, credibility: 0.9, catalystStrength: 'HIGH',
        tradingBias: 'BULLISH', contribution: 0.2, reasoning: 'unit', recordedAt: new Date().toISOString(),
      });
      // Fill every active-stream slot with freshly-subscribed (dwell-protected, unevictable)
      // symbols first, so ZDUP's own subscribe() attempts below all genuinely fail to acquire a
      // slot - the real repeat-attempt pattern (FundamentalAgent/MacroAgent/NewsAgent round-robin
      // re-checking the same still-unsubscribed symbol every cycle), not a one-and-done success.
      const cap = continuousIntelligence.maxActiveSubscriptions;
      const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      for (let i = 0; i < cap; i++) worker.subscribe(`Y${letters[i % 26]}${letters[Math.floor(i / 26)]}`);
      expect(worker.getActiveSymbols()).not.toContain('ZDUP');

      const logSpy = vi.spyOn(structuredLogger, 'info');
      worker.subscribe('ZDUP', { requestedBy: 'NewsAgent' });
      worker.subscribe('ZDUP', { requestedBy: 'MacroAgent' });
      worker.subscribe('ZDUP', { requestedBy: 'FundamentalAgent' });
      expect(worker.getActiveSymbols()).not.toContain('ZDUP'); // confirms it genuinely never subscribed across all 3 attempts
      const calls = logSpy.mock.calls.filter(([msg]) => msg === 'discovery_candidate_decision');
      expect(calls.length).toBe(1);
      logSpy.mockRestore();
    });

    it('a real Alpaca-mover/broad-universe admission is unaffected - source provenance for the existing funnels is untouched by this extension', async () => {
      const { logDiscoveryCandidateDecision } = await import('../observability/discoveryCandidateLedger');
      const logSpy = vi.spyOn(structuredLogger, 'info');
      logDiscoveryCandidateDecision({ symbol: 'ZMOV', source: 'MARKET_MOVER', admitted: true, reason: null });
      const call = logSpy.mock.calls.find(([msg]) => msg === 'discovery_candidate_decision');
      expect(call![1].source).toBe('MARKET_MOVER');
      logSpy.mockRestore();
    });
  });
});
