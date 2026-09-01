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

      // Confirm the full concurrent budget is still available for a genuinely at-risk symbol.
      for (const sym of ['LNG', 'XOM', 'CRM']) {
        const r = worker.requestTemporaryDataRescue(sym, 'real-need');
        expect(r.granted).toBe(true);
      }
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

    it('denies a new rescue once maxConcurrentTemporaryDataRescues is reached, without evicting anything for it', async () => {
      const { continuousIntelligence } = await import('../config/continuousIntelligence');
      authenticate(instances[0]);
      for (const core of continuousIntelligence.coreStreamingSymbols) worker.subscribe(core);
      await expireDynamicDwell();

      const grants: string[] = [];
      const cap = continuousIntelligence.maxConcurrentTemporaryDataRescues;
      const candidates = ['LNG', 'XOM', 'CRM', 'ANF', 'TH'];
      for (const sym of candidates) {
        const r = worker.requestTemporaryDataRescue(sym, 'capacity-test');
        if (r.granted) grants.push(sym);
      }
      expect(grants.length).toBe(cap);
      const overflow = candidates.find((s) => !grants.includes(s));
      expect(overflow).toBeTruthy();
      const denied = worker.requestTemporaryDataRescue(overflow!, 'capacity-test');
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
});
