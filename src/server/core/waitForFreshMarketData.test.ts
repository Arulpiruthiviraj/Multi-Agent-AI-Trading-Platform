import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { requestTemporaryDataRescue, getLatestPrice, getLatestPriceAgeMs } = vi.hoisted(() => ({
  requestTemporaryDataRescue: vi.fn(),
  getLatestPrice: vi.fn(),
  getLatestPriceAgeMs: vi.fn(),
}));
vi.mock('../services/MarketDataWorker', () => ({
  marketDataWorker: { requestTemporaryDataRescue, getLatestPrice, getLatestPriceAgeMs },
}));

import { waitForFreshMarketData, resetWaitForFreshMarketDataForTests } from './waitForFreshMarketData';

describe('waitForFreshMarketData (NewsEngine price-race fix, Sept-2 audit remediation)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    requestTemporaryDataRescue.mockReset();
    getLatestPrice.mockReset();
    getLatestPriceAgeMs.mockReset();
    resetWaitForFreshMarketDataForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Case 1: symbol already subscribed and fresh - immediate price available.
  it('returns immediately when a fresh tick is already available', async () => {
    requestTemporaryDataRescue.mockReturnValue({ granted: true, symbol: 'AAPL', alreadySubscribed: true, evictedSymbol: null });
    getLatestPrice.mockReturnValue(230.5);
    getLatestPriceAgeMs.mockReturnValue(500);

    const outcome = await waitForFreshMarketData('AAPL', { requestClass: 'NEWS_CATALYST', reason: 'test' });
    expect(outcome).toEqual({ ok: true, price: 230.5, alreadyFresh: true });
    expect(requestTemporaryDataRescue).toHaveBeenCalledWith('AAPL', 'test', { requestClass: 'NEWS_CATALYST', traceId: undefined });
  });

  // Case 2: symbol not subscribed - subscription granted, tick arrives after a short delay.
  it('polls until a fresh tick arrives after a granted rescue for a not-yet-subscribed symbol', async () => {
    requestTemporaryDataRescue.mockReturnValue({ granted: true, symbol: 'DELL', alreadySubscribed: false, evictedSymbol: null });
    let call = 0;
    getLatestPrice.mockImplementation(() => (call >= 3 ? 118.2 : null));
    getLatestPriceAgeMs.mockImplementation(() => { call++; return call >= 3 ? 100 : null; });

    const promise = waitForFreshMarketData('DELL', { requestClass: 'NEWS_CATALYST', reason: 'test', traceId: 'trace-1' });
    await vi.advanceTimersByTimeAsync(1000);
    const outcome = await promise;
    expect(outcome).toEqual({ ok: true, price: 118.2, alreadyFresh: false });
  });

  // Case 3: subscription granted but no tick ever arrives - explicit timeout, no invalid idea.
  it('returns an explicit TIMEOUT when no fresh tick arrives within the bounded window', async () => {
    requestTemporaryDataRescue.mockReturnValue({ granted: true, symbol: 'ZZZZ', alreadySubscribed: false, evictedSymbol: null });
    getLatestPrice.mockReturnValue(null);
    getLatestPriceAgeMs.mockReturnValue(null);

    const promise = waitForFreshMarketData('ZZZZ', { requestClass: 'NEWS_CATALYST', reason: 'test' });
    await vi.advanceTimersByTimeAsync(20_000);
    const outcome = await promise;
    expect(outcome).toEqual({ ok: false, reason: 'TIMEOUT' });
  });

  // Case 4: only a stale tick exists - must be rejected, never treated as fresh.
  it('treats a stale tick as no data - never returns a stale price', async () => {
    requestTemporaryDataRescue.mockReturnValue({ granted: true, symbol: 'SPY', alreadySubscribed: true, evictedSymbol: null });
    getLatestPrice.mockReturnValue(450.0);
    getLatestPriceAgeMs.mockReturnValue(600_000); // 10 minutes - well past stalePriceThresholdMs (5 min)

    const promise = waitForFreshMarketData('SPY', { requestClass: 'NEWS_CATALYST', reason: 'test' });
    await vi.advanceTimersByTimeAsync(20_000);
    const outcome = await promise;
    expect(outcome).toEqual({ ok: false, reason: 'TIMEOUT' });
  });

  // Case 5: allocator denies the rescue (capacity full) - explicit denial reason, no fake idea.
  it('returns RESCUE_DENIED immediately when the allocator denies capacity, without polling at all', async () => {
    requestTemporaryDataRescue.mockReturnValue({
      granted: false, symbol: 'XYZ', alreadySubscribed: false, evictedSymbol: null, deniedReason: 'RESCUE_CAPACITY_FULL',
    });

    const outcome = await waitForFreshMarketData('XYZ', { requestClass: 'NEWS_CATALYST', reason: 'test' });
    expect(outcome).toEqual({ ok: false, reason: 'RESCUE_DENIED', deniedReason: 'RESCUE_CAPACITY_FULL' });
    expect(getLatestPrice).not.toHaveBeenCalled();
  });

  // Case 6: duplicate/concurrent requests for the same symbol share one in-flight wait.
  it('deduplicates concurrent waits for the same symbol into a single in-flight request', async () => {
    requestTemporaryDataRescue.mockReturnValue({ granted: true, symbol: 'NVDA', alreadySubscribed: true, evictedSymbol: null });
    getLatestPrice.mockReturnValue(180.0);
    getLatestPriceAgeMs.mockReturnValue(100);

    const [a, b] = await Promise.all([
      waitForFreshMarketData('NVDA', { requestClass: 'NEWS_CATALYST', reason: 'first' }),
      waitForFreshMarketData('NVDA', { requestClass: 'NEWS_CATALYST', reason: 'second' }),
    ]);
    expect(a).toEqual({ ok: true, price: 180.0, alreadyFresh: true });
    expect(b).toBe(a);
    // Only one real allocator call for the deduplicated pair.
    expect(requestTemporaryDataRescue).toHaveBeenCalledTimes(1);
  });

  it('never throws even if the allocator call itself throws - returns a typed ERROR result instead', async () => {
    requestTemporaryDataRescue.mockImplementation(() => { throw new Error('boom'); });
    const outcome = await waitForFreshMarketData('BOOM', { requestClass: 'NEWS_CATALYST', reason: 'test' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.reason).toBe('ERROR');
  });
});
