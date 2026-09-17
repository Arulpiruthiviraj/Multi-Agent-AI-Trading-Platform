import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { tradingSafety } from '../../config/tradingSafety';

/**
 * Real integration test (isolated temp SQLite DB) for Phase 2C's corporate-actions safety check.
 * Seeds real ohlcv_bars rows directly (simulating an already-cached raw fetch) and mocks the
 * comparison split-adjustment HTTP call, since a real Alpaca account isn't available in this
 * environment - the comparison LOGIC (relative-difference detection, pagination, credential/
 * error fallbacks) is what's under test, not Alpaca connectivity itself.
 */
describe('HistoricalDataGateway.checkForUnadjustedCorporateActions', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let historicalDataGateway: any;
  const originalAlpacaKey = process.env.ALPACA_API_KEY;
  const originalAlpacaSecret = process.env.ALPACA_SECRET_KEY;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_corpactions_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_SECRET_KEY = 'test-secret';

    ({ db, sqliteDb } = await import('../../db'));
    schema = await import('../../db/schema');
    ({ historicalDataGateway } = await import('./HistoricalDataGateway'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
    if (originalAlpacaKey === undefined) delete process.env.ALPACA_API_KEY; else process.env.ALPACA_API_KEY = originalAlpacaKey;
    if (originalAlpacaSecret === undefined) delete process.env.ALPACA_SECRET_KEY; else process.env.ALPACA_SECRET_KEY = originalAlpacaSecret;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    historicalDataGateway.clearBarsRateLimitBackoff();
  });

  async function seedRawBar(symbol: string, timeframe: string, timestamp: number, close: number) {
    await db.insert(schema.ohlcvBars).values({
      id: `${symbol}:${timeframe}:${timestamp}`, symbol, timeframe, timestamp,
      open: close, high: close, low: close, close, volume: 1000, source: 'alpaca',
    });
  }

  it('reports checked:false, not a fabricated clean verdict, when Alpaca credentials are unset', async () => {
    delete process.env.ALPACA_API_KEY;
    const result = await historicalDataGateway.checkForUnadjustedCorporateActions('NOKEY', '1Day', 0, 1);
    expect(result.checked).toBe(false);
    expect(result.clean).toBe(true); // "clean" here means "not flagged as dirty", not "verified clean"
    process.env.ALPACA_API_KEY = 'test-key';
  });

  it('detects a real unadjusted split: raw and split-adjusted closes differ materially for the same bar', async () => {
    const ts = new Date('2024-01-15').getTime();
    await seedRawBar('SPLITCO', '1Day', ts, 400); // pre-split raw close

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ bars: [{ t: '2024-01-15T00:00:00Z', c: 100 }] }), // split-adjusted: 4:1 split
    })));

    const result = await historicalDataGateway.checkForUnadjustedCorporateActions('SPLITCO', '1Day', ts - 1000, ts + 1000);
    expect(result.checked).toBe(true);
    expect(result.clean).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain('SPLITCO');
    expect(result.issues[0]).toMatch(/split/i);
  });

  it('reports clean when raw and split-adjusted closes agree (no real corporate action occurred)', async () => {
    const ts = new Date('2024-02-15').getTime();
    await seedRawBar('CLEANCO', '1Day', ts, 150);

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ bars: [{ t: '2024-02-15T00:00:00Z', c: 150 }] }),
    })));

    const result = await historicalDataGateway.checkForUnadjustedCorporateActions('CLEANCO', '1Day', ts - 1000, ts + 1000);
    expect(result.checked).toBe(true);
    expect(result.clean).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('tolerates immaterial floating-point-level differences without a false positive', async () => {
    const ts = new Date('2024-03-15').getTime();
    await seedRawBar('TINYDIFF', '1Day', ts, 100.00);

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ bars: [{ t: '2024-03-15T00:00:00Z', c: 100.001 }] }), // 0.001% difference
    })));

    const result = await historicalDataGateway.checkForUnadjustedCorporateActions('TINYDIFF', '1Day', ts - 1000, ts + 1000);
    expect(result.clean).toBe(true);
  });

  it('does not fabricate a clean verdict when the comparison fetch itself fails', async () => {
    const ts = new Date('2024-04-15').getTime();
    await seedRawBar('FETCHFAIL', '1Day', ts, 100);

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));

    const result = await historicalDataGateway.checkForUnadjustedCorporateActions('FETCHFAIL', '1Day', ts - 1000, ts + 1000);
    expect(result.checked).toBe(false);
  });

  it('paginates through multiple pages of the split-adjustment comparison, same as the real fetch does', async () => {
    const ts1 = new Date('2024-05-01').getTime();
    const ts2 = new Date('2024-05-02').getTime();
    await seedRawBar('PAGED', '1Day', ts1, 100);
    await seedRawBar('PAGED', '1Day', ts2, 200);

    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++;
      if (call === 1) return { ok: true, json: async () => ({ bars: [{ t: '2024-05-01T00:00:00Z', c: 100 }], next_page_token: 'page2' }) };
      return { ok: true, json: async () => ({ bars: [{ t: '2024-05-02T00:00:00Z', c: 200 }] }) };
    }));

    const result = await historicalDataGateway.checkForUnadjustedCorporateActions('PAGED', '1Day', ts1 - 1000, ts2 + 1000);
    expect(result.checked).toBe(true);
    expect(result.clean).toBe(true);
    expect(call).toBe(2);
  });

  it('refuses look-ahead ingestion when publishedAtMs is after asOfMs', async () => {
    await expect(historicalDataGateway.ingestPitLedgerEntry({
      asOfMs: 1_000,
      publishedAtMs: 2_000,
      symbol: 'AAPL',
      kind: 'NEWS',
      impactScore: 90,
    })).rejects.toThrow(/LOOK_AHEAD_FORBIDDEN/);
  });

  it('returns NEWS published at or before simulated now and hides later rows', async () => {
    const nowMs = Date.UTC(2024, 5, 3, 16, 0, 0);
    await historicalDataGateway.ingestPitLedgerEntry({
      asOfMs: nowMs - 60_000,
      publishedAtMs: nowMs - 60_000,
      symbol: 'PITCO',
      kind: 'NEWS',
      impactScore: 91,
      finbertScore: 0.4,
    });
    await historicalDataGateway.ingestPitLedgerEntry({
      asOfMs: nowMs + 60_000,
      publishedAtMs: nowMs + 60_000,
      symbol: 'PITCO',
      kind: 'NEWS',
      impactScore: 99,
    });
    const visible = await historicalDataGateway.getPitNewsAsOf('PITCO', nowMs);
    expect(visible).toHaveLength(1);
    expect(visible[0].impactScore).toBe(91);
    expect(visible[0].publishedAtMs).toBeLessThanOrEqual(nowMs);
  });

  it('returns AI rows published at or before simulated now and hides later rows', async () => {
    const nowMs = Date.UTC(2024, 5, 4, 16, 0, 0);
    await historicalDataGateway.ingestPitLedgerEntry({
      asOfMs: nowMs - 1_000,
      publishedAtMs: nowMs - 1_000,
      symbol: 'AICO',
      kind: 'AGENT_REASONING',
      agent: 'TechnicalAgent',
      side: 'BUY',
      confidence: 0.8,
    });
    await historicalDataGateway.ingestPitLedgerEntry({
      asOfMs: nowMs + 1_000,
      publishedAtMs: nowMs + 1_000,
      symbol: 'AICO',
      kind: 'AGENT_REASONING',
      agent: 'NewsAgent',
      side: 'BUY',
      confidence: 0.9,
    });
    const visible = await historicalDataGateway.getPitAiRowsAsOf('AICO', nowMs, nowMs - 60_000);
    expect(visible).toHaveLength(1);
    expect(visible[0].agent).toBe('TechnicalAgent');
    expect(visible[0].publishedAtMs).toBeLessThanOrEqual(nowMs);
  });

  it('arms a shared 429 backoff and fail-closes without fabricating bars', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: { get: (k: string) => (k.toLowerCase() === 'retry-after' ? '2' : null) },
      text: async () => 'rate limited',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const now = Date.now();
    await expect(
      historicalDataGateway.ensureBars('RATE429', '1Day', now - 86_400_000, now),
    ).rejects.toThrow(/429 Too Many Requests/);

    expect(historicalDataGateway.getBarsRateLimitedUntilMs()).toBeGreaterThan(Date.now());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Subsequent ensureBars for any symbol must fail closed without another Alpaca call
    // when the local cache is empty.
    await expect(
      historicalDataGateway.ensureBars('OTHER', '1Day', now - 86_400_000, now),
    ).rejects.toThrow(/rate-limited until/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a real Alpaca fetch during a synthetic simulation session and never calls fetch (regression, 2026-09-15: a synthetic CERTIFIED_BULLISH_ENTRY_EXIT run\'s own isolated DB was found holding 275 real live-fetched SPY 1Day bars, meaning JavaCoreEnsemble had been evaluating real market history instead of the synthetic scenario on every certification run)', async () => {
    historicalDataGateway.clearBarsRateLimitBackoff();
    const fetchMock = vi.fn(async () => {
      throw new Error('fetch must not be called during a synthetic simulation session');
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.SYNTHETIC_SIMULATION = 'true';
    try {
      const now = Date.now();
      await expect(
        historicalDataGateway.ensureBars('SYNTHNODATA', '1Day', now - 86_400_000, now),
      ).rejects.toThrow(/refuses a real network fetch/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.SYNTHETIC_SIMULATION;
    }
  });

  it('returns normally under SYNTHETIC_SIMULATION when the cache already has sufficient bars, still without calling fetch', async () => {
    historicalDataGateway.clearBarsRateLimitBackoff();
    const fetchMock = vi.fn(async () => {
      throw new Error('fetch must not be called when cache is already sufficient');
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.SYNTHETIC_SIMULATION = 'true';
    try {
      const now = Date.now();
      const start = now - tradingSafety.regimeMinBars * 86_400_000;
      for (let i = 0; i < tradingSafety.regimeMinBars; i++) {
        const ts = start + i * 86_400_000;
        await db.insert(schema.ohlcvBars).values({
          id: `SYNTHCACHED:1Day:${ts}`, symbol: 'SYNTHCACHED', timeframe: '1Day', timestamp: ts,
          open: 10, high: 11, low: 9, close: 10.5, volume: 1000, source: 'synthetic_simulation',
        }).onConflictDoNothing();
      }
      await historicalDataGateway.ensureBars('SYNTHCACHED', '1Day', start, now);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.SYNTHETIC_SIMULATION;
    }
  });

  it('skips Alpaca when SQLite already has regimeMinBars coverage (cache-first)', async () => {
    historicalDataGateway.clearBarsRateLimitBackoff();
    const fetchMock = vi.fn(async () => {
      throw new Error('fetch should not be called');
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = Date.now();
    const start = now - tradingSafety.regimeMinBars * 86_400_000;
    for (let i = 0; i < tradingSafety.regimeMinBars; i++) {
      const ts = start + i * 86_400_000;
      await db.insert(schema.ohlcvBars).values({
        id: `CACHE1:1Day:${ts}`,
        symbol: 'CACHE1',
        timeframe: '1Day',
        timestamp: ts,
        open: 10,
        high: 11,
        low: 9,
        close: 10.5,
        volume: 1000,
        source: 'alpaca',
      }).onConflictDoNothing();
    }

    await historicalDataGateway.ensureBars('CACHE1', '1Day', start, now);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses registered ibkr_gateway provider and never calls Alpaca fetch', async () => {
    const { registerHistoricalBarProvider } = await import('./historicalBarProvider');
    historicalDataGateway.clearBarsRateLimitBackoff();
    const fetchMock = vi.fn(async () => {
      throw new Error('Alpaca must not be called when IBKR provider is registered');
    });
    vi.stubGlobal('fetch', fetchMock);

    const now = Date.now();
    const start = now - 90 * 86_400_000;
    const ibkrBars = Array.from({ length: 70 }, (_, i) => ({
      timestamp: start + i * 86_400_000,
      open: 10,
      high: 11,
      low: 9,
      close: 10.5,
      volume: 1000,
    }));
    registerHistoricalBarProvider({
      id: 'ibkr_gateway',
      fetchBars: async () => ibkrBars,
    });

    try {
      await historicalDataGateway.ensureBars('IBKRHIST', '1Day', start, now);
      expect(fetchMock).not.toHaveBeenCalled();
      const cached = await historicalDataGateway.getBars('IBKRHIST', '1Day', start, now);
      expect(cached.length).toBeGreaterThanOrEqual(60);
    } finally {
      registerHistoricalBarProvider(null);
    }
  });

  // 2026-09-10 real fix: confirmed live that IBKR's historical-bar API returns empty for real,
  // liquid US symbols on this account (same market-data-entitlement gap already found on the
  // live streaming path) - this silently starved MissedOpportunityEvaluator forever (every
  // record stayed PENDING). ensureBars() now falls back to Alpaca instead of failing closed
  // immediately when IBKR itself has nothing to offer.
  describe('IBKR -> Alpaca fallback (2026-09-10 fix)', () => {
    afterEach(async () => {
      const { registerHistoricalBarProvider } = await import('./historicalBarProvider');
      registerHistoricalBarProvider(null);
    });

    it('falls back to a real Alpaca fetch when the registered IBKR provider returns empty bars', async () => {
      const { registerHistoricalBarProvider } = await import('./historicalBarProvider');
      historicalDataGateway.clearBarsRateLimitBackoff();
      registerHistoricalBarProvider({ id: 'ibkr_gateway', fetchBars: async () => [] });

      const now = Date.now();
      const start = now - 90 * 86_400_000;
      const alpacaBars = Array.from({ length: 70 }, (_, i) => ({
        t: new Date(start + i * 86_400_000).toISOString(), o: 10, h: 11, l: 9, c: 10.5, v: 1000,
      }));
      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ bars: alpacaBars }) }));
      vi.stubGlobal('fetch', fetchMock);

      await historicalDataGateway.ensureBars('IBKREMPTY', '1Day', start, now);

      expect(fetchMock).toHaveBeenCalled(); // real Alpaca fallback fetch happened
      const cached = await historicalDataGateway.getBars('IBKREMPTY', '1Day', start, now);
      expect(cached.length).toBeGreaterThanOrEqual(60);
    });

    it('falls back to a real Alpaca fetch when the registered IBKR provider throws', async () => {
      const { registerHistoricalBarProvider } = await import('./historicalBarProvider');
      historicalDataGateway.clearBarsRateLimitBackoff();
      registerHistoricalBarProvider({
        id: 'ibkr_gateway',
        fetchBars: async () => { throw new Error('IBKR market-data rejection: code=354 not subscribed'); },
      });

      const now = Date.now();
      const start = now - 90 * 86_400_000;
      const alpacaBars = Array.from({ length: 70 }, (_, i) => ({
        t: new Date(start + i * 86_400_000).toISOString(), o: 20, h: 21, l: 19, c: 20.5, v: 500,
      }));
      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ bars: alpacaBars }) }));
      vi.stubGlobal('fetch', fetchMock);

      await historicalDataGateway.ensureBars('IBKRTHROWS', '1Day', start, now);

      expect(fetchMock).toHaveBeenCalled();
      const cached = await historicalDataGateway.getBars('IBKRTHROWS', '1Day', start, now);
      expect(cached.length).toBeGreaterThanOrEqual(60);
    });

    it('still never fabricates a bar - throws a real error when BOTH IBKR and the Alpaca fallback have nothing', async () => {
      const { registerHistoricalBarProvider } = await import('./historicalBarProvider');
      historicalDataGateway.clearBarsRateLimitBackoff();
      registerHistoricalBarProvider({ id: 'ibkr_gateway', fetchBars: async () => [] });

      const now = Date.now();
      const start = now - 90 * 86_400_000;
      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ bars: [] }) }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(historicalDataGateway.ensureBars('NODATAANYWHERE', '1Day', start, now)).rejects.toThrow(
        /No historical bars available/
      );
    });

    it('prefers existing cached bars over a fresh Alpaca call when IBKR fails but SQLite already has some coverage', async () => {
      const { registerHistoricalBarProvider } = await import('./historicalBarProvider');
      historicalDataGateway.clearBarsRateLimitBackoff();
      registerHistoricalBarProvider({ id: 'ibkr_gateway', fetchBars: async () => { throw new Error('IBKR down'); } });

      const now = Date.now();
      const start = now - 90 * 86_400_000;
      // Seed just enough cached bars to clear tradingSafety.regimeMinBars via the existing
      // cache-first check, before ensureBars() ever reaches the IBKR/Alpaca branches at all.
      for (let i = 0; i < tradingSafety.regimeMinBars; i++) {
        await seedRawBar('CACHEDENOUGH', '1Day', start + i * 86_400_000, 50 + i);
      }
      const fetchMock = vi.fn(async () => { throw new Error('must not be called - cache-first should short-circuit'); });
      vi.stubGlobal('fetch', fetchMock);

      await historicalDataGateway.ensureBars('CACHEDENOUGH', '1Day', start, now);

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('memoryBars bounded eviction (P1-A remediation Patch B, 2026-09-14 - real, standalone defect: the cache had no active eviction path, growing without bound as distinct symbol/timeframe/hour-bucket keys were queried)', () => {
    it('never grows past historicalBarsMemoryCacheMaxEntries even when many more distinct keys are queried', async () => {
      const max = tradingSafety.historicalBarsMemoryCacheMaxEntries;
      const extra = 200; // comfortably more than the configured cap, to prove real eviction occurs
      for (let i = 0; i < max + extra; i++) {
        // Each i gets a distinct symbol -> distinct memoryKey (symbol|timeframe|hourBucket) -
        // ohlcv_bars is empty for all of these, so getBars() always takes the cache-miss path and
        // calls cacheSet() every time, exactly like production evaluating many distinct
        // symbol/hour combinations across a wide real timestamp spread.
        await historicalDataGateway.getBars(`EVICT${i}`, '1Min', 0, 60_000);
      }
      expect(historicalDataGateway.getMemoryBarsCacheSize()).toBeLessThanOrEqual(max);
      // Not merely "small by coincidence" - prove the bound is actually being enforced, not that
      // fewer than max distinct keys happened to be queried.
      expect(historicalDataGateway.getMemoryBarsCacheSize()).toBeGreaterThan(0);
    });

    it('evicts the least-recently-used entry, not simply the oldest-inserted one', async () => {
      const max = tradingSafety.historicalBarsMemoryCacheMaxEntries;
      // Fill the cache with a fresh, uniquely-prefixed batch so this test is independent of
      // whatever the previous test already left cached.
      for (let i = 0; i < max; i++) {
        await historicalDataGateway.getBars(`LRU${i}`, '1Min', 0, 60_000);
      }
      // Touch the very first key again (a cache HIT - well within its 60s TTL) - this should move
      // it to the most-recently-used end, so it survives the eviction the next new key triggers.
      await historicalDataGateway.getBars('LRU0', '1Min', 0, 60_000);
      // One brand-new key pushes the cache one over the cap, forcing exactly one eviction. Since
      // LRU0 was just re-touched (MRU), LRU1 - the next-oldest untouched key - is the one that
      // must actually be evicted (proving real LRU, not FIFO-by-insertion-order, which would have
      // evicted LRU0 first since it was the oldest-INSERTED key).
      await historicalDataGateway.getBars('LRU_NEW_KEY', '1Min', 0, 60_000);
      expect(historicalDataGateway.getMemoryBarsCacheSize()).toBeLessThanOrEqual(max);

      // db.select() is the observable seam that distinguishes a cache HIT (never queries SQLite)
      // from a MISS (always does). getBars() itself never calls fetch/network for either case -
      // it's a pure local-DB path - so this spy is the correct signal, not a fetch stub.
      const { db: dbModule } = await import('../../db');
      const selectSpy = vi.spyOn(dbModule, 'select');

      await historicalDataGateway.getBars('LRU0', '1Min', 0, 60_000); // still cached -> HIT
      expect(selectSpy).not.toHaveBeenCalled();

      await historicalDataGateway.getBars('LRU1', '1Min', 0, 60_000); // was evicted -> real MISS
      expect(selectSpy).toHaveBeenCalledTimes(1);

      selectSpy.mockRestore();
    });
  });
});
