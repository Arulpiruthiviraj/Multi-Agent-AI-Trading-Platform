import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { tradingSafety } from '../config/tradingSafety';

describe('AlphaVantageBudget (DEF-13)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let AlphaVantageBudget: typeof import('./AlphaVantageBudget').AlphaVantageBudget;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_avbudget_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb } = await import('../db'));
    ({ AlphaVantageBudget } = await import('./AlphaVantageBudget'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  beforeEach(async () => {
    await AlphaVantageBudget.resetForTests();
  });

  it('loads the daily cap from tradingSafety.json, not a TS literal', () => {
    expect(tradingSafety.alphaVantageDailyRequestBudget).toBeGreaterThan(0);
  });

  it('allows requests until the shared daily budget is exhausted, then denies', async () => {
    const cap = tradingSafety.alphaVantageDailyRequestBudget;
    expect(await AlphaVantageBudget.tryConsume(cap)).toBe(true);
    expect(await AlphaVantageBudget.tryConsume(1)).toBe(false);
    expect(await AlphaVantageBudget.remaining()).toBe(0);
  });

  it('resets on a new UTC calendar day', async () => {
    const cap = tradingSafety.alphaVantageDailyRequestBudget;
    const day1 = Date.UTC(2026, 7, 17, 12, 0, 0);
    const day2 = Date.UTC(2026, 7, 18, 0, 0, 1);
    expect(await AlphaVantageBudget.tryConsume(cap, day1)).toBe(true);
    expect(await AlphaVantageBudget.tryConsume(1, day1)).toBe(false);
    expect(await AlphaVantageBudget.tryConsume(1, day2)).toBe(true);
  });

  it('2026-08-18 forensic fix: a permanently-hung enqueued call times out instead of starving every later caller forever (both agents share this one queue)', async () => {
    // Simulate the failure mode found live: something inside one tryConsume() call never
    // settles. Before the lock-timeout fix, every subsequent enqueue() (from either
    // FundamentalAgent or MacroAgent) would queue behind it and never resolve either.
    const originalGetStale = (await import('./ExternalDataCache')).ExternalDataCache.getStale;
    const ExternalDataCacheMod = await import('./ExternalDataCache');
    let hungCallSeen = false;
    (ExternalDataCacheMod.ExternalDataCache as any).getStale = async (...args: any[]) => {
      if (!hungCallSeen) {
        hungCallSeen = true;
        return new Promise(() => { /* never resolves - the hang under test */ });
      }
      return originalGetStale.apply(ExternalDataCacheMod.ExternalDataCache, args as any);
    };

    vi.useFakeTimers();
    try {
      // Fires the hung call; do not await it - it would never settle on its own.
      const hungPromise = AlphaVantageBudget.tryConsume(1);
      let hungRejected = false;
      hungPromise.catch(() => { hungRejected = true; });

      // A later, real call must still resolve (queued behind the hang, but the shared lock
      // self-releases via the timeout instead of blocking this forever).
      const laterPromise = AlphaVantageBudget.tryConsume(1);

      await vi.advanceTimersByTimeAsync(tradingSafety.alphaVantageBudgetLockTimeoutMs + 100);

      const laterResult = await laterPromise;
      expect(typeof laterResult).toBe('boolean');
      expect(hungRejected).toBe(true);
    } finally {
      vi.useRealTimers();
      (ExternalDataCacheMod.ExternalDataCache as any).getStale = originalGetStale;
    }
  }, 15_000);
});
