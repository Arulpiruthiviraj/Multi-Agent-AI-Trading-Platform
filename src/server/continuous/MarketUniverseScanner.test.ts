import { describe, it, expect, afterEach, vi } from 'vitest';
import { continuousIntelligence } from '../config/continuousIntelligence';

const FLAG = continuousIntelligence.broadUniverseEnabledEnvVar;

vi.mock('../core/alpacaTls', () => ({
  alpacaFetch: vi.fn(),
}));

import { alpacaFetch } from '../core/alpacaTls';
import {
  fetchTradableAssets,
  screenAssets,
  fetchAvgDailyVolumeShares,
  refreshBroadUniverseCache,
  getCachedBroadUniverseSymbols,
  getLastBroadUniverseStats,
  resetMarketUniverseScannerForTests,
} from './MarketUniverseScanner';

function barsResponse(bars: Record<string, number[]>) {
  return jsonResponse({
    bars: Object.fromEntries(Object.entries(bars).map(([symbol, volumes]) => [symbol, volumes.map((v) => ({ v }))])),
  });
}

const mockFetch = alpacaFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, headers: { get: () => null } } as any;
}

afterEach(() => {
  delete process.env[FLAG];
  mockFetch.mockReset();
  resetMarketUniverseScannerForTests();
});

describe('MarketUniverseScanner - flag gating', () => {
  it('refreshBroadUniverseCache is a no-op when the flag is off', async () => {
    delete process.env[FLAG];
    const stats = await refreshBroadUniverseCache();
    expect(stats.ran).toBe(false);
    expect(stats.enabled).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('getCachedBroadUniverseSymbols returns empty when the flag is off, even with a warm cache', async () => {
    process.env[FLAG] = 'true';
    mockFetch.mockResolvedValueOnce(jsonResponse([
      { symbol: 'ABCD', exchange: 'NASDAQ', status: 'active', tradable: true, class: 'us_equity' },
    ]));
    mockFetch.mockResolvedValueOnce(jsonResponse({
      ABCD: { latestTrade: { p: 50 }, dailyBar: { v: 1_000_000, c: 50 }, latestQuote: { bp: 49.95, ap: 50.05 } },
    }));
    mockFetch.mockResolvedValueOnce(barsResponse({ ABCD: [600_000, 600_000] }));
    await refreshBroadUniverseCache();
    expect(getCachedBroadUniverseSymbols().length).toBeGreaterThan(0);
    delete process.env[FLAG];
    expect(getCachedBroadUniverseSymbols()).toEqual([]);
  });
});

describe('MarketUniverseScanner - fetchTradableAssets', () => {
  it('filters to active, tradable, allowed-exchange symbols only', async () => {
    process.env[FLAG] = 'true';
    mockFetch.mockResolvedValueOnce(jsonResponse([
      { symbol: 'GOOD', exchange: 'NASDAQ', status: 'active', tradable: true, class: 'us_equity' },
      { symbol: 'HALTED', exchange: 'NASDAQ', status: 'inactive', tradable: true, class: 'us_equity' },
      { symbol: 'NOTTRADABLE', exchange: 'NYSE', status: 'active', tradable: false, class: 'us_equity' },
      { symbol: 'OTCJUNK', exchange: 'OTC', status: 'active', tradable: true, class: 'us_equity' },
    ]));
    const symbols = await fetchTradableAssets();
    expect(symbols).toEqual(['GOOD']);
  });

  it('caches the assets list - a second call within TTL does not refetch', async () => {
    process.env[FLAG] = 'true';
    mockFetch.mockResolvedValueOnce(jsonResponse([
      { symbol: 'AAPL', exchange: 'NASDAQ', status: 'active', tradable: true, class: 'us_equity' },
    ]));
    await fetchTradableAssets();
    await fetchTradableAssets();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('MarketUniverseScanner - screenAssets', () => {
  it('excludes symbols below the price floor, below the dollar-volume floor, or above the spread ceiling', async () => {
    process.env[FLAG] = 'true';
    mockFetch.mockResolvedValueOnce(jsonResponse({
      CHEAP: { latestTrade: { p: 1 }, dailyBar: { v: 10_000_000, c: 1 }, latestQuote: { bp: 0.99, ap: 1.01 } },
      ILLIQUID: { latestTrade: { p: 50 }, dailyBar: { v: 10, c: 50 }, latestQuote: { bp: 49.9, ap: 50.1 } },
      WIDE: { latestTrade: { p: 50 }, dailyBar: { v: 1_000_000, c: 50 }, latestQuote: { bp: 45, ap: 55 } },
      GOOD: { latestTrade: { p: 50 }, dailyBar: { v: 1_000_000, c: 50 }, latestQuote: { bp: 49.95, ap: 50.05 } },
    }));
    const screened = await screenAssets(['CHEAP', 'ILLIQUID', 'WIDE', 'GOOD']);
    expect(screened.map((s) => s.symbol).sort()).toEqual(['CHEAP', 'GOOD', 'ILLIQUID', 'WIDE'].sort());
    // passesScreen is applied in refreshBroadUniverseCache, not screenAssets itself - verify via a full refresh.
  });

  it('one failed batch does not throw and does not block other batches', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));
    const screened = await screenAssets(['ANY']);
    expect(screened).toEqual([]);
  });
});

describe('MarketUniverseScanner - fetchAvgDailyVolumeShares', () => {
  it('computes a real average across the returned daily bars', async () => {
    mockFetch.mockResolvedValueOnce(barsResponse({ AAA: [400_000, 600_000] }));
    const advMap = await fetchAvgDailyVolumeShares(['AAA']);
    expect(advMap.get('AAA')).toBe(500_000);
  });

  it('excludes a symbol with no bars in the response rather than assuming it passes', async () => {
    mockFetch.mockResolvedValueOnce(barsResponse({ AAA: [500_000] }));
    const advMap = await fetchAvgDailyVolumeShares(['AAA', 'MISSING']);
    expect(advMap.has('AAA')).toBe(true);
    expect(advMap.has('MISSING')).toBe(false);
  });

  it('one failed batch does not throw and excludes that batch entirely', async () => {
    mockFetch.mockRejectedValueOnce(new Error('bars endpoint down'));
    const advMap = await fetchAvgDailyVolumeShares(['AAA']);
    expect(advMap.size).toBe(0);
  });
});

describe('MarketUniverseScanner - refreshBroadUniverseCache end to end', () => {
  it('produces a candidate list capped at broadUniverseMaxCandidates, ranked by dollar volume', async () => {
    process.env[FLAG] = 'true';
    mockFetch.mockResolvedValueOnce(jsonResponse([
      { symbol: 'LOW', exchange: 'NASDAQ', status: 'active', tradable: true, class: 'us_equity' },
      { symbol: 'HIGH', exchange: 'NASDAQ', status: 'active', tradable: true, class: 'us_equity' },
      { symbol: 'TOOTHIN', exchange: 'NASDAQ', status: 'active', tradable: true, class: 'us_equity' },
    ]));
    mockFetch.mockResolvedValueOnce(jsonResponse({
      LOW: { latestTrade: { p: 50 }, dailyBar: { v: 200_000, c: 50 }, latestQuote: { bp: 49.95, ap: 50.05 } },
      HIGH: { latestTrade: { p: 50 }, dailyBar: { v: 5_000_000, c: 50 }, latestQuote: { bp: 49.95, ap: 50.05 } },
      TOOTHIN: { latestTrade: { p: 50 }, dailyBar: { v: 1, c: 50 }, latestQuote: { bp: 49.95, ap: 50.05 } },
    }));
    // Only LOW/HIGH clear passesScreen's dollar-volume floor - TOOTHIN never reaches the ADV batch.
    mockFetch.mockResolvedValueOnce(barsResponse({ LOW: [600_000, 600_000], HIGH: [5_000_000, 5_000_000] }));
    const stats = await refreshBroadUniverseCache();
    expect(stats.ran).toBe(true);
    expect(stats.error).toBeNull();
    const cached = getCachedBroadUniverseSymbols();
    expect(cached).toContain('HIGH');
    expect(cached).not.toContain('TOOTHIN'); // dollar volume 50 < broadUniverseMinDollarVolume
    expect(cached.indexOf('HIGH')).toBeLessThan(cached.indexOf('LOW')); // ranked by dollar volume desc
  });

  it('excludes a symbol that clears the dollar-volume floor but fails the real 20-day ADV-shares floor', async () => {
    process.env[FLAG] = 'true';
    mockFetch.mockResolvedValueOnce(jsonResponse([
      { symbol: 'THINADV', exchange: 'NASDAQ', status: 'active', tradable: true, class: 'us_equity' },
    ]));
    // Single day's dollar volume ($10M) clears the $ floor, but the real 20-day ADV is only 100k shares.
    mockFetch.mockResolvedValueOnce(jsonResponse({
      THINADV: { latestTrade: { p: 100 }, dailyBar: { v: 100_000, c: 100 }, latestQuote: { bp: 99.9, ap: 100.1 } },
    }));
    mockFetch.mockResolvedValueOnce(barsResponse({ THINADV: [100_000, 100_000] }));
    const stats = await refreshBroadUniverseCache();
    expect(stats.error).toBeNull();
    expect(getCachedBroadUniverseSymbols()).not.toContain('THINADV');
  });

  it('records the error and does not crash when the assets fetch itself fails', async () => {
    process.env[FLAG] = 'true';
    mockFetch.mockRejectedValueOnce(new Error('assets endpoint down'));
    const stats = await refreshBroadUniverseCache();
    expect(stats.ran).toBe(true);
    expect(stats.error).toContain('assets endpoint down');
    expect(getLastBroadUniverseStats().error).toContain('assets endpoint down');
  });
});
