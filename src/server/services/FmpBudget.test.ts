import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { tradingSafety } from '../config/tradingSafety';

describe('FmpBudget (2026-09-10, FMP fallback for FundamentalAgent)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let FmpBudget: typeof import('./FmpBudget').FmpBudget;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_fmpbudget_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb } = await import('../db'));
    ({ FmpBudget } = await import('./FmpBudget'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  beforeEach(async () => {
    await FmpBudget.resetForTests();
  });

  it('loads the daily cap from tradingSafety.json, not a TS literal', () => {
    expect(tradingSafety.fmpDailyRequestBudget).toBeGreaterThan(0);
  });

  it('allows requests until the free-tier daily budget is exhausted, then denies', async () => {
    const cap = tradingSafety.fmpDailyRequestBudget;
    expect(await FmpBudget.tryConsume(cap)).toBe(true);
    expect(await FmpBudget.tryConsume(1)).toBe(false);
    expect(await FmpBudget.remaining()).toBe(0);
  });

  it('resets on a new UTC calendar day', async () => {
    const cap = tradingSafety.fmpDailyRequestBudget;
    const day1 = Date.UTC(2026, 8, 10, 12, 0, 0);
    const day2 = Date.UTC(2026, 8, 11, 0, 0, 1);
    expect(await FmpBudget.tryConsume(cap, day1)).toBe(true);
    expect(await FmpBudget.tryConsume(1, day1)).toBe(false);
    expect(await FmpBudget.tryConsume(1, day2)).toBe(true);
  });

  it('never counts against the separate AlphaVantageBudget daily counter - fully independent budgets', async () => {
    const { AlphaVantageBudget } = await import('./AlphaVantageBudget');
    await AlphaVantageBudget.resetForTests();
    await FmpBudget.tryConsume(tradingSafety.fmpDailyRequestBudget);
    expect(await AlphaVantageBudget.remaining()).toBe(tradingSafety.alphaVantageDailyRequestBudget);
  });

  it('2026-10-12 (M4): lock-timeout releases the CALLER but the chain still serializes on the real fn() settlement - no lost-update race on the budget counter', async () => {
    // Mirrors the AlphaVantageBudget M4 regression test: advancing the shared chain on the
    // CALLER's lock-timeout rejection let the next enqueued read-modify-write run
    // concurrently with the still-running write, silently losing one counter increment.
    const ExternalDataCacheMod = await import('./ExternalDataCache');
    const originalGetStale = (ExternalDataCacheMod.ExternalDataCache as any).getStale;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((res) => { releaseFirst = res; });
    let firstCallSeen = false;
    (ExternalDataCacheMod.ExternalDataCache as any).getStale = async (...args: any[]) => {
      if (!firstCallSeen) {
        firstCallSeen = true;
        await firstGate; // stall fn #1 past the lock timeout, then let it finish for real
      }
      return originalGetStale.apply(ExternalDataCacheMod.ExternalDataCache, args as any);
    };

    vi.useFakeTimers();
    try {
      const p1 = FmpBudget.tryConsume(1);
      let p1Error: any = null;
      p1.catch((e) => { p1Error = e; });
      const p2 = FmpBudget.tryConsume(1);
      let p2Outcome: string | null = null;
      p2.then(
        (v) => { p2Outcome = `resolved:${v}`; },
        (e) => { p2Outcome = `rejected:${e?.message}`; },
      );

      // Past the lock timeout: caller #1 is released immediately with the loud error...
      await vi.advanceTimersByTimeAsync(tradingSafety.fmpBudgetLockTimeoutMs + 100);
      expect(p1Error).toBeInstanceOf(Error);
      expect(p1Error.message).toMatch(/exceeded \d+ms/);

      // ...but caller #2 must NOT have run yet: the chain waits for fn #1's real
      // settlement, so the two read-modify-writes can never overlap.
      await vi.advanceTimersByTimeAsync(5000);
      expect(p2Outcome).toBeNull();

      // fn #1's real write lands (used=1); only then does the chain advance and fn #2 run.
      releaseFirst();
      vi.useRealTimers();
      expect(await p2).toBe(true);
      expect(p2Outcome).toBe('resolved:true');

      // Both real outcomes are reflected: used=2, not a lost update of used=1.
      const cap = tradingSafety.fmpDailyRequestBudget;
      expect(await FmpBudget.remaining()).toBe(cap - 2);
    } finally {
      vi.useRealTimers();
      (ExternalDataCacheMod.ExternalDataCache as any).getStale = originalGetStale;
    }
  }, 15_000);
});
