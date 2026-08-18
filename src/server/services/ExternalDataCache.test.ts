import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Real integration test (isolated temp SQLite DB) for the cache/rate-limit logic that closes the
 * real AlphaVantage quota-exhaustion bug found this pass: FundamentalAgent/MacroAgent were each
 * polling every 60-75s against a real key rate-limited to 25 requests/day, exhausting it within
 * minutes and then hammering the exhausted quota every cycle thereafter.
 */
describe('ExternalDataCache', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let ExternalDataCache: any;
  let looksLikeRateLimitResponse: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_extcache_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb } = await import('../db'));
    ({ ExternalDataCache, looksLikeRateLimitResponse } = await import('./ExternalDataCache'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('returns null on a cache miss - never fabricates a payload', async () => {
    const result = await ExternalDataCache.getFresh('alphavantage', 'fundamentals', 'NOPE', 1000);
    expect(result).toBeNull();
  });

  it('getStale returns the last successful payload even when outside the freshness window (429 fallback)', async () => {
    await ExternalDataCache.set('alphavantage', 'fundamentals', 'STALE429', { peRatio: '22.1' });
    expect(await ExternalDataCache.getFresh('alphavantage', 'fundamentals', 'STALE429', -1)).toBeNull();
    expect(await ExternalDataCache.getStale('alphavantage', 'fundamentals', 'STALE429')).toEqual({ peRatio: '22.1' });
  });

  it('stores and retrieves a real payload within the freshness window', async () => {
    await ExternalDataCache.set('alphavantage', 'fundamentals', 'AAPL', { peRatio: '31.2' });
    const result = await ExternalDataCache.getFresh('alphavantage', 'fundamentals', 'AAPL', 60_000);
    expect(result).toEqual({ peRatio: '31.2' });
  });

  it('treats a payload older than the freshness window as a miss, not stale data', async () => {
    await ExternalDataCache.set('alphavantage', 'fundamentals', 'MSFT', { peRatio: '35.0' });
    const result = await ExternalDataCache.getFresh('alphavantage', 'fundamentals', 'MSFT', -1); // already "expired"
    expect(result).toBeNull();
  });

  it('marks and reports a real rate-limit cooldown', async () => {
    expect(await ExternalDataCache.isRateLimited('alphavantage', 'fundamentals', 'TSLA')).toBe(false);
    await ExternalDataCache.markRateLimited('alphavantage', 'fundamentals', 'TSLA');
    expect(await ExternalDataCache.isRateLimited('alphavantage', 'fundamentals', 'TSLA')).toBe(true);
  });

  it('a subsequent real success clears the rate-limit cooldown', async () => {
    await ExternalDataCache.markRateLimited('alphavantage', 'fundamentals', 'NVDA');
    expect(await ExternalDataCache.isRateLimited('alphavantage', 'fundamentals', 'NVDA')).toBe(true);

    await ExternalDataCache.set('alphavantage', 'fundamentals', 'NVDA', { peRatio: '40.1' });
    expect(await ExternalDataCache.isRateLimited('alphavantage', 'fundamentals', 'NVDA')).toBe(false);
  });

  it('symbol=null caches macro-style, symbol-independent data separately from any per-symbol cache', async () => {
    await ExternalDataCache.set('alphavantage', 'macro', null, { inflation: '3.1' });
    const macro = await ExternalDataCache.getFresh('alphavantage', 'macro', null, 60_000);
    const perSymbol = await ExternalDataCache.getFresh('alphavantage', 'fundamentals', null as any, 60_000);
    expect(macro).toEqual({ inflation: '3.1' });
    expect(perSymbol).toBeNull(); // different dataType, same symbol key - must not collide
  });

  describe('looksLikeRateLimitResponse', () => {
    it('detects the real AlphaVantage rate-limit response shape (confirmed live against the actual key)', () => {
      expect(looksLikeRateLimitResponse({
        Information: 'We have detected your API key as XXXX and our standard API rate limit is 25 requests per day.',
      })).toBe(true);
    });

    it('detects the older per-minute throttle wording too, via a Note field', () => {
      expect(looksLikeRateLimitResponse({ Note: 'Thank you for using Alpha Vantage! Our standard API call frequency is 5 calls per minute.' })).toBe(true);
    });

    it('does not flag a real, successful data response', () => {
      expect(looksLikeRateLimitResponse({ PERatio: '31.2', QuarterlyEarningsGrowthYOY: '0.12' })).toBe(false);
    });
  });

  describe('hashObject (Phase 7 - LLM-analysis cache key)', () => {
    let hashObject: any;
    beforeAll(async () => {
      ({ hashObject } = await import('./ExternalDataCache'));
    });

    it('produces the identical hash for the identical data', () => {
      const data = { peRatio: '31.2', epsGrowth: '12', debtToEquity: '0.8' };
      expect(hashObject(data)).toBe(hashObject({ peRatio: '31.2', epsGrowth: '12', debtToEquity: '0.8' }));
    });

    it('the real point of this hash: produces a DIFFERENT hash when the underlying data actually changes', () => {
      const before = { peRatio: '31.2', epsGrowth: '12', debtToEquity: '0.8' };
      const after = { peRatio: '32.5', epsGrowth: '12', debtToEquity: '0.8' }; // P/E updated
      expect(hashObject(before)).not.toBe(hashObject(after));
    });
  });
});
