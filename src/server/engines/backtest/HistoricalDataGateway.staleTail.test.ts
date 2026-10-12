// LABEL: COMPONENT / FAULT_INJECTION
/**
 * HistoricalDataGateway stale-tail policy — regression tests for the 2026-10-12 forensic
 * question (ARGUS_OCT12_LIVE_FORENSIC_INTERIM_2026-10-12.md): XLI's daily cache tail was
 * ~46.6 days stale.
 *
 * Investigation conclusion (code + git history): the stale-tail gate (landed in main
 * 2026-10-10, commit f9277c7) DOES force a provider refresh for present-time requests whose
 * tail is older than quantBarsTailFreshnessToleranceMs, and failed refreshes surface as a
 * loud DATA_STALE error rather than being relabeled fresh. No code defect in the refresh
 * policy was proven; the live XLI staleness is most plausibly a provider data gap, a
 * pre-gate deployment, or lack of recent present-time XLI requests — recorded as UNKNOWN
 * per the investigation mandate (no fix invented).
 *
 * These tests lock in the correct policy behavior with a stale-tail fixture so a future
 * regression (e.g. re-adding a silent stale-cache return) is caught.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('HistoricalDataGateway stale-tail policy (2026-10-12)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let historicalDataGateway: any;
  const originalAlpacaKey = process.env.ALPACA_API_KEY;
  const originalAlpacaSecret = process.env.ALPACA_SECRET_KEY;

  const now = Date.now();
  const start = now - 200 * 86_400_000;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_staletail_${Date.now()}_${process.pid}.db`);
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

  beforeEach(() => {
    vi.unstubAllGlobals();
    historicalDataGateway.clearBarsRateLimitBackoff();
    historicalDataGateway.clearBarsMemoryCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Seeds 70 daily bars ending `tailAgeDays` ago, all inside the [start, now] query window
   *  (like the XLI fixture: plenty of rows so the count/coverage sufficiency check passes,
   *  but a stale tail so the freshness gate must engage). */
  async function seedStaleTail(symbol: string, tailAgeDays: number) {
    const tailTs = now - tailAgeDays * 86_400_000;
    for (let i = 0; i < 70; i++) {
      const ts = tailTs - (69 - i) * 86_400_000;
      if (ts < start) throw new Error('fixture bug: seeded bar outside query window');
      await db.insert(schema.ohlcvBars).values({
        id: `${symbol}:1Day:${ts}`, symbol, timeframe: '1Day', timestamp: ts,
        open: 100, high: 101, low: 99, close: 100.5, volume: 1000,
        source: 'alpaca', provisional: 0,
      });
    }
  }

  function alpacaBarsResponse(count: number, endTs: number, close: number) {
    return {
      ok: true,
      json: async () => ({
        bars: Array.from({ length: count }, (_, i) => {
          const t = new Date(endTs - (count - 1 - i) * 86_400_000).toISOString();
          return { t, o: close, h: close + 1, l: close - 1, c: close, v: 1000 };
        }),
      }),
    };
  }

  it('a 50-day-stale tail with an empty provider response throws DATA_STALE (never silently fresh)', async () => {
    await seedStaleTail('STALEXLI', 50);
    // No IBKR provider registered; Alpaca returns nothing.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ bars: [] }) })));
    await expect(historicalDataGateway.ensureBars('STALEXLI', '1Day', start, now))
      .rejects.toThrow(/DATA_STALE/);
  });

  it('a 50-day-stale tail with a healthy provider refreshes and the tail moves', async () => {
    await seedStaleTail('STALEXLI2', 50);
    const fetchMock = vi.fn(async () => alpacaBarsResponse(10, now, 105));
    vi.stubGlobal('fetch', fetchMock);
    await historicalDataGateway.ensureBars('STALEXLI2', '1Day', start, now);
    expect(fetchMock).toHaveBeenCalled(); // refresh was actually attempted
    const bars = await historicalDataGateway.getBars('STALEXLI2', '1Day', start, now);
    const newest = bars[bars.length - 1].timestamp;
    expect(now - newest).toBeLessThan(3 * 86_400_000);
  });

  it('a fresh tail does not call the provider (existing cache-first behavior preserved)', async () => {
    await seedStaleTail('FRESHTAIL', 1);
    const fetchMock = vi.fn(async () => { throw new Error('provider must not be called'); });
    vi.stubGlobal('fetch', fetchMock);
    await historicalDataGateway.ensureBars('FRESHTAIL', '1Day', start, now);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
