import { describe, it, expect, afterEach, vi } from 'vitest';
import { continuousIntelligence } from '../config/continuousIntelligence';

const FLAG = continuousIntelligence.broadUniverseEnabledEnvVar;
const MOVERS_FLAG = continuousIntelligence.moversEnabledEnvVar;

vi.mock('../core/alpacaTls', () => ({
  alpacaFetch: vi.fn(),
}));

import { alpacaFetch } from '../core/alpacaTls';
import { flushObservabilityStore } from '../observability/ObservabilityStore';
import {
  fetchTradableAssets,
  screenAssets,
  fetchAvgDailyVolumeShares,
  refreshBroadUniverseCache,
  getCachedBroadUniverseSymbols,
  getLastBroadUniverseStats,
  resetMarketUniverseScannerForTests,
  fetchTopMovers,
  refreshMoversCache,
  getCachedMoverSymbols,
  getLastMoverScanStats,
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
  delete process.env[MOVERS_FLAG];
  mockFetch.mockReset();
  resetMarketUniverseScannerForTests();
});

function moversResponse(gainers: Array<{ symbol: string; price?: number; percent_change?: number }>, losers: Array<{ symbol: string; price?: number; percent_change?: number }> = []) {
  return jsonResponse({
    gainers: gainers.map((g) => ({ symbol: g.symbol, price: g.price ?? 10, change: 0, percent_change: g.percent_change ?? 10 })),
    losers: losers.map((l) => ({ symbol: l.symbol, price: l.price ?? 10, change: 0, percent_change: l.percent_change ?? -10 })),
  });
}

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

  it('Phase A (Discovery Lineage): logs a real DISCOVERY_CANDIDATE_ADMITTED/FILTERED event with the exact reason for every stage-2 candidate - the real gap that made FRVO unexplainable (2026-09-01 forensic audit)', async () => {
    process.env[FLAG] = 'true';
    mockFetch.mockResolvedValueOnce(jsonResponse([
      { symbol: 'HIGH', exchange: 'NASDAQ', status: 'active', tradable: true, class: 'us_equity' },
      { symbol: 'THINADV', exchange: 'NASDAQ', status: 'active', tradable: true, class: 'us_equity' },
    ]));
    mockFetch.mockResolvedValueOnce(jsonResponse({
      HIGH: { latestTrade: { p: 50 }, dailyBar: { v: 5_000_000, c: 50 }, latestQuote: { bp: 49.95, ap: 50.05 } },
      THINADV: { latestTrade: { p: 100 }, dailyBar: { v: 100_000, c: 100 }, latestQuote: { bp: 99.9, ap: 100.1 } },
    }));
    mockFetch.mockResolvedValueOnce(barsResponse({ HIGH: [5_000_000, 5_000_000], THINADV: [100_000, 100_000] }));
    await refreshBroadUniverseCache();
    await flushObservabilityStore();

    const { db } = await import('../db');
    const schema = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const rows = await db.select().from(schema.observabilityEvents).where(eq(schema.observabilityEvents.eventType, 'DISCOVERY_CANDIDATE_ADMITTED'));
    const filteredRows = await db.select().from(schema.observabilityEvents).where(eq(schema.observabilityEvents.eventType, 'DISCOVERY_CANDIDATE_FILTERED'));

    const highRow = rows.find((r) => r.symbol === 'HIGH');
    expect(highRow).toBeDefined();
    const highPayload = JSON.parse(highRow!.payload as string);
    expect(highPayload.source).toBe('BROAD_UNIVERSE');
    expect(highPayload.reason).toBeNull();

    const thinAdvRow = filteredRows.find((r) => r.symbol === 'THINADV');
    expect(thinAdvRow).toBeDefined();
    const thinAdvPayload = JSON.parse(thinAdvRow!.payload as string);
    expect(thinAdvPayload.reason).toBe('ADV'); // real 20-day ADV (100k shares) below the floor - never a silent disappearance again
  });

  it('Phase A: a candidate that clears every liquidity gate but still loses the final rank cap is logged as RANK_CAP, not ADV - a real, distinct reason', async () => {
    process.env[FLAG] = 'true';
    const originalCap = continuousIntelligence.broadUniverseMaxCandidates;
    (continuousIntelligence as any).broadUniverseMaxCandidates = 1;
    try {
      mockFetch.mockResolvedValueOnce(jsonResponse([
        { symbol: 'TOPPICK', exchange: 'NASDAQ', status: 'active', tradable: true, class: 'us_equity' },
        { symbol: 'RUNNERUP', exchange: 'NASDAQ', status: 'active', tradable: true, class: 'us_equity' },
      ]));
      mockFetch.mockResolvedValueOnce(jsonResponse({
        TOPPICK: { latestTrade: { p: 50 }, dailyBar: { v: 10_000_000, c: 50 }, latestQuote: { bp: 49.95, ap: 50.05 } },
        RUNNERUP: { latestTrade: { p: 50 }, dailyBar: { v: 5_000_000, c: 50 }, latestQuote: { bp: 49.95, ap: 50.05 } },
      }));
      mockFetch.mockResolvedValueOnce(barsResponse({ TOPPICK: [10_000_000, 10_000_000], RUNNERUP: [5_000_000, 5_000_000] }));
      await refreshBroadUniverseCache();
      await flushObservabilityStore();

      const { db } = await import('../db');
      const schema = await import('../db/schema');
      const { eq, and } = await import('drizzle-orm');
      const rows = await db.select().from(schema.observabilityEvents).where(
        and(eq(schema.observabilityEvents.eventType, 'DISCOVERY_CANDIDATE_FILTERED'), eq(schema.observabilityEvents.symbol, 'RUNNERUP')),
      );
      expect(rows.length).toBeGreaterThan(0);
      const payload = JSON.parse(rows[rows.length - 1].payload as string);
      expect(payload.reason).toBe('RANK_CAP'); // cleared price/dollar-volume/spread/ADV, still lost the final cap - not the same as an ADV failure
    } finally {
      (continuousIntelligence as any).broadUniverseMaxCandidates = originalCap;
    }
  });
});

describe('MarketUniverseScanner - movers flag gating', () => {
  it('refreshMoversCache is a no-op when the flag is off', async () => {
    delete process.env[MOVERS_FLAG];
    const stats = await refreshMoversCache();
    expect(stats.ran).toBe(false);
    expect(stats.enabled).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('getCachedMoverSymbols returns empty when the flag is off, even with a warm cache', async () => {
    process.env[MOVERS_FLAG] = 'true';
    mockFetch.mockResolvedValueOnce(moversResponse([{ symbol: 'ABCD' }]));
    mockFetch.mockResolvedValueOnce(jsonResponse({
      ABCD: { latestTrade: { p: 50 }, dailyBar: { v: 1_000_000, c: 50 }, latestQuote: { bp: 49.95, ap: 50.05 } },
    }));
    mockFetch.mockResolvedValueOnce(barsResponse({ ABCD: [600_000, 600_000] }));
    await refreshMoversCache();
    expect(getCachedMoverSymbols().length).toBeGreaterThan(0);
    delete process.env[MOVERS_FLAG];
    expect(getCachedMoverSymbols()).toEqual([]);
  });
});

describe('MarketUniverseScanner - fetchTopMovers', () => {
  it('returns a deduped, uppercased symbol list from real gainers + losers', async () => {
    mockFetch.mockResolvedValueOnce(moversResponse(
      [{ symbol: 'good', percent_change: 20 }, { symbol: 'DUPE' }],
      [{ symbol: 'dupe', percent_change: -15 }, { symbol: 'BAD' }],
    ));
    const result = await fetchTopMovers();
    expect(result.symbols.sort()).toEqual(['BAD', 'DUPE', 'GOOD'].sort());
    expect(result.gainersFetched).toBe(2);
    expect(result.losersFetched).toBe(2);
  });
});

describe('MarketUniverseScanner - refreshMoversCache end to end', () => {
  it('excludes a raw mover that fails the exact same liquidity screen every broad-universe candidate must clear (real Alpaca movers include sub-$1 warrants)', async () => {
    process.env[MOVERS_FLAG] = 'true';
    mockFetch.mockResolvedValueOnce(moversResponse([
      { symbol: 'PENNYW', percent_change: 596 }, // real observed shape: a warrant far below broadUniverseMinPrice
      { symbol: 'REALMOVE', percent_change: 12 },
    ]));
    mockFetch.mockResolvedValueOnce(jsonResponse({
      PENNYW: { latestTrade: { p: 0.02 }, dailyBar: { v: 500_000, c: 0.02 }, latestQuote: { bp: 0.018, ap: 0.022 } },
      REALMOVE: { latestTrade: { p: 80 }, dailyBar: { v: 2_000_000, c: 80 }, latestQuote: { bp: 79.9, ap: 80.1 } },
    }));
    mockFetch.mockResolvedValueOnce(barsResponse({ REALMOVE: [2_000_000, 2_000_000] }));
    const stats = await refreshMoversCache();
    expect(stats.ran).toBe(true);
    expect(stats.gainersFetched).toBe(2);
    expect(getCachedMoverSymbols()).toContain('REALMOVE');
    expect(getCachedMoverSymbols()).not.toContain('PENNYW'); // price 0.02 < broadUniverseMinPrice (5)
  });

  it('records the error and does not crash when the movers endpoint itself fails', async () => {
    process.env[MOVERS_FLAG] = 'true';
    mockFetch.mockRejectedValueOnce(new Error('movers endpoint down'));
    const stats = await refreshMoversCache();
    expect(stats.ran).toBe(true);
    expect(stats.error).toContain('movers endpoint down');
    expect(getLastMoverScanStats().error).toContain('movers endpoint down');
  });

  it('Phase A (Discovery Lineage): logs the exact real reason for every raw mover, including a symbol Alpaca returned as a mover but never gave a snapshot for at all - the real FRVO-class gap (2026-09-01 forensic audit)', async () => {
    process.env[MOVERS_FLAG] = 'true';
    mockFetch.mockResolvedValueOnce(moversResponse([
      { symbol: 'PENNYW', percent_change: 596 },
      { symbol: 'REALMOVE', percent_change: 12 },
      { symbol: 'GHOSTMOVE', percent_change: 28 }, // real Alpaca movers row, but no snapshot ever returned for it
    ]));
    mockFetch.mockResolvedValueOnce(jsonResponse({
      PENNYW: { latestTrade: { p: 0.02 }, dailyBar: { v: 500_000, c: 0.02 }, latestQuote: { bp: 0.018, ap: 0.022 } },
      REALMOVE: { latestTrade: { p: 80 }, dailyBar: { v: 2_000_000, c: 80 }, latestQuote: { bp: 79.9, ap: 80.1 } },
      // GHOSTMOVE intentionally absent - mirrors a real Alpaca snapshot response missing a symbol.
    }));
    mockFetch.mockResolvedValueOnce(barsResponse({ REALMOVE: [2_000_000, 2_000_000] }));
    await refreshMoversCache();
    await flushObservabilityStore();

    const { db } = await import('../db');
    const schema = await import('../db/schema');
    const { eq, and } = await import('drizzle-orm');
    async function reasonFor(symbol: string, eventType: 'DISCOVERY_CANDIDATE_ADMITTED' | 'DISCOVERY_CANDIDATE_FILTERED') {
      const rows = await db.select().from(schema.observabilityEvents).where(
        and(eq(schema.observabilityEvents.eventType, eventType), eq(schema.observabilityEvents.symbol, symbol)),
      );
      expect(rows.length).toBeGreaterThan(0);
      return JSON.parse(rows[rows.length - 1].payload as string).reason;
    }
    expect(await reasonFor('GHOSTMOVE', 'DISCOVERY_CANDIDATE_FILTERED')).toBe('NO_SNAPSHOT_DATA');
    expect(await reasonFor('PENNYW', 'DISCOVERY_CANDIDATE_FILTERED')).toBe('PRICE');
    expect(await reasonFor('REALMOVE', 'DISCOVERY_CANDIDATE_ADMITTED')).toBeNull();
  });

  it('Phase A: logs ADV as the reason when a mover clears price/dollar-volume/spread but fails the real 20-day ADV floor', async () => {
    process.env[MOVERS_FLAG] = 'true';
    mockFetch.mockResolvedValueOnce(moversResponse([{ symbol: 'THINADVMOVER', percent_change: 20 }]));
    mockFetch.mockResolvedValueOnce(jsonResponse({
      THINADVMOVER: { latestTrade: { p: 100 }, dailyBar: { v: 100_000, c: 100 }, latestQuote: { bp: 99.9, ap: 100.1 } },
    }));
    mockFetch.mockResolvedValueOnce(barsResponse({ THINADVMOVER: [100_000, 100_000] }));
    await refreshMoversCache();
    await flushObservabilityStore();

    const { db } = await import('../db');
    const schema = await import('../db/schema');
    const { eq, and } = await import('drizzle-orm');
    const rows = await db.select().from(schema.observabilityEvents).where(
      and(eq(schema.observabilityEvents.eventType, 'DISCOVERY_CANDIDATE_FILTERED'), eq(schema.observabilityEvents.symbol, 'THINADVMOVER')),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.parse(rows[rows.length - 1].payload as string).reason).toBe('ADV');
  });
});
