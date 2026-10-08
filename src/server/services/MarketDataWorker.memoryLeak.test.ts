import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

/**
 * Memory-leak regression tests for the Market Data subsystem (2026-10-08 leak hunt).
 *
 * Proves the per-symbol growth surfaces in MarketDataWorker stay bounded:
 *   1. subscribe/unsubscribe churn over many DISTINCT tickers leaves every per-symbol
 *      collection at its pre-churn size (unsubscribe purges, including the 2026-10-05
 *      delayedQuotes/lastNewsDiscoveryLogMs/lastRejectLogMs cleanup and the 2026-10-07
 *      Market-D3 quote-cache purge).
 *   2. Sustained tick ingestion over a fixed symbol set does not grow the V8 heap
 *      (tick path only overwrites fixed-size per-symbol slots - no append buffers).
 *   3. cacheObservedQuote() (the synthetic-session / crypto ingestion writer) repeated
 *      overwrites do not grow the heap.
 *   4. recordDelayedQuote() (the out-of-order/IBKR-delayed side buffer) is fully purged
 *      by unsubscribe.
 *
 * Deterministic measurement: forces a full GC before and after each phase via
 * global.gc() (run with NODE_OPTIONS=--expose-gc) and compares heapUsed deltas.
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
      (this.listeners[event] || []).forEach((cb) => cb(...args));
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

// Non-recording stubs: vi.fn() mocks retain every call's arguments, which would
// masquerade as heap growth in the high-volume tick phases below. These tests assert
// bounded growth, not event-bus wiring, so plain no-ops are the honest choice.
vi.mock('../core/EventBus', () => ({ eventBus: { emitMarketData: () => {}, emit: () => {}, subscribe: () => {} } }));
vi.mock('../core/ideaGenerationGate', () => ({
  isLiveIdeaGenerationEnabled: () => true,
  isAutobotTradingEnabled: () => true,
}));

import { MarketDataWorker } from './MarketDataWorker';

type WorkerAny = { [k: string]: Map<string, unknown> | Set<string> };

/** Every per-symbol collection in MarketDataWorker that must stay bounded. */
const PER_SYMBOL_COLLECTIONS = [
  'activeStreams',
  'latestPrices',
  'latestPriceTimestamps',
  'latestAskPrices',
  'latestAskTimestamps',
  'latestBidEvidence',
  'lastTick',
  'tickCounts',
  'dynamicMomentumScores',
  'subscribedAtMs',
  'marketDataErrors',
  'delayedQuotes',
  'lastNewsDiscoveryLogMs',
  'lastRejectLogMs',
  'temporaryRescues',
] as const;

function collectionSizes(w: WorkerAny): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of PER_SYMBOL_COLLECTIONS) out[name] = (w[name] as Map<string, unknown> | Set<string>).size;
  return out;
}

function gcAndHeapMb(): number {
  if (typeof global.gc === 'function') global.gc();
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

/** Distinct 5-letter tickers (looksLikeListedTicker allows 1-5 letters) for churn. */
function churnTicker(i: number): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const c1 = A[Math.floor(i / (26 * 26)) % 26];
  const c2 = A[Math.floor(i / 26) % 26];
  const c3 = A[i % 26];
  return `ZZ${c1}${c2}${c3}`;
}

describe('MarketDataWorker memory bounds (leak-hunt regression)', () => {
  let w: WorkerAny;

  beforeEach(() => {
    w = new MarketDataWorker() as unknown as WorkerAny;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('subscribe/unsubscribe churn over distinct tickers leaves all per-symbol collections at baseline', () => {
    // Warm up the churn paths once so JIT/allocation warmup is outside the measured window.
    const warm = churnTicker(0);
    (w as any).subscribe(warm);
    (w as any).ingestIbkrQuote(warm, 100);
    (w as any).recordDelayedQuote(warm, 66, 99.9);
    (w as any).unsubscribe(warm, { force: true });

    const sizesBefore = collectionSizes(w);
    const heapBefore = gcAndHeapMb();

    // 300 full lifecycles with distinct tickers: subscribe -> ticks -> delayed quote ->
    // tick rejection -> unsubscribe. None of these may leave residue.
    for (let i = 1; i <= 300; i++) {
      const sym = churnTicker(i);
      (w as any).subscribe(sym);
      for (let t = 0; t < 10; t++) (w as any).ingestIbkrQuote(sym, 100 + t * 0.01);
      (w as any).ingestIbkrBidAsk(sym, 1, 99.99);
      (w as any).ingestIbkrBidAsk(sym, 2, 100.01);
      (w as any).recordDelayedQuote(sym, 66, 99.98);
      (w as any).recordDelayedQuote(sym, 67, 100.02);
      // Route a tick rejection through the dedup log (keyed `${TICKER}|${reason}`).
      (w as any).rejectTick(sym, 'INVALID_TIMESTAMP', { timestampMs: NaN, price: 1 });
      (w as any).unsubscribe(sym, { force: true });
    }

    const heapAfter = gcAndHeapMb();
    const sizesAfter = collectionSizes(w);

    for (const name of PER_SYMBOL_COLLECTIONS) {
      expect(sizesAfter[name], `${name} grew during subscribe/unsubscribe churn`).toBe(sizesBefore[name]);
    }
    // Heap is a coarse sanity check only (V8 heap deltas are noisy across runs -
    // the per-collection size assertions above are the deterministic leak check).
    // 10MB budget for 300 churn lifecycles; a real per-cycle leak would be 100s of MB.
    expect(heapAfter - heapBefore).toBeLessThan(10);
  });

  it('sustained tick ingestion over a fixed symbol set does not grow the heap', () => {
    const symbols = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'META', 'GOOGL', 'AMD', 'AVGO', 'NFLX'];
    for (const s of symbols) (w as any).subscribe(s);

    // Warmup: exercise the tick path (dedup, acceptTickTimestamp, caches, emit).
    for (let t = 0; t < 5000; t++) {
      const s = symbols[t % symbols.length];
      (w as any).ingestIbkrQuote(s, 100 + (t % 1000) * 0.001);
    }
    const sizesWarm = collectionSizes(w);
    const heapWarm = gcAndHeapMb();

    // 200k ticks across the fixed set - a proxy for a long soak session's tick volume.
    for (let t = 0; t < 200_000; t++) {
      const s = symbols[t % symbols.length];
      (w as any).ingestIbkrQuote(s, 100 + (t % 1000) * 0.001);
    }

    const heapAfter = gcAndHeapMb();
    const sizesAfter = collectionSizes(w);
    for (const name of PER_SYMBOL_COLLECTIONS) {
      expect(sizesAfter[name], `${name} grew during tick ingestion`).toBe(sizesWarm[name]);
    }
    // Tick ingestion only overwrites fixed-size slots: budget 2MB over 200k ticks.
    expect(heapAfter - heapWarm).toBeLessThan(2);

    for (const s of symbols) (w as any).unsubscribe(s, { force: true });
  });

  it('cacheObservedQuote repeated overwrites do not grow the heap (synthetic-session writer)', () => {
    const symbols = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN'];
    // Warmup.
    for (let t = 0; t < 2000; t++) {
      const s = symbols[t % symbols.length];
      (w as any).cacheObservedQuote(s, 100 + t * 0.0001, Date.now() - 1000);
    }
    const sizeWarm = (w.latestPrices as Map<string, number>).size;
    const heapWarm = gcAndHeapMb();

    // 100k overwrites - same write pattern SyntheticSessionEngine uses per bar.
    for (let t = 0; t < 100_000; t++) {
      const s = symbols[t % symbols.length];
      (w as any).cacheObservedQuote(s, 100 + t * 0.0001, Date.now() - 1000);
    }

    const heapAfter = gcAndHeapMb();
    expect((w.latestPrices as Map<string, number>).size).toBe(sizeWarm);
    // Coarse sanity check only (see note above); the map-size assertion is determinative.
    expect(heapAfter - heapWarm).toBeLessThan(10);
  });

  it('recordDelayedQuote entries are fully purged by unsubscribe', () => {
    const sym = churnTicker(999);
    (w as any).subscribe(sym);
    (w as any).recordDelayedQuote(sym, 66, 99.9);
    (w as any).recordDelayedQuote(sym, 67, 100.1);
    (w as any).recordDelayedQuote(sym, 68, 100.0);
    (w as any).recordDelayedQuote(sym, 69, 99.95);
    expect((w.delayedQuotes as Map<string, unknown>).has(sym)).toBe(true);
    // Overwrites of the same fields must not add entries either.
    (w as any).recordDelayedQuote(sym, 66, 99.91);
    expect(((w.delayedQuotes as Map<string, unknown>).get(sym) as Map<number, unknown>).size).toBe(4);

    (w as any).unsubscribe(sym, { force: true });
    expect((w.delayedQuotes as Map<string, unknown>).has(sym)).toBe(false);
  });
});
