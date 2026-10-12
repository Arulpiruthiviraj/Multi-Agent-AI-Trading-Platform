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

  it('allows requests until the shared daily budget is exhausted, then denies (MacroAgent, exempt from the reserved-slot cap)', async () => {
    const cap = tradingSafety.alphaVantageDailyRequestBudget;
    expect(await AlphaVantageBudget.tryConsume(cap, undefined, 'MacroAgent')).toBe(true);
    expect(await AlphaVantageBudget.tryConsume(1, undefined, 'MacroAgent')).toBe(false);
    expect(await AlphaVantageBudget.remaining()).toBe(0);
  });

  it('resets on a new UTC calendar day', async () => {
    const cap = tradingSafety.alphaVantageDailyRequestBudget;
    const day1 = Date.UTC(2026, 7, 17, 12, 0, 0);
    const day2 = Date.UTC(2026, 7, 18, 0, 0, 1);
    expect(await AlphaVantageBudget.tryConsume(cap, day1, 'MacroAgent')).toBe(true);
    expect(await AlphaVantageBudget.tryConsume(1, day1, 'MacroAgent')).toBe(false);
    expect(await AlphaVantageBudget.tryConsume(1, day2, 'MacroAgent')).toBe(true);
  });

  it('Consensus Quality Audit (2026-08-25): a non-MacroAgent caller cannot spend into the slots reserved for MacroAgent, but MacroAgent itself can still spend them', async () => {
    const cap = tradingSafety.alphaVantageDailyRequestBudget;
    const reserved = tradingSafety.alphaVantageMacroReservedRequests;
    const nonMacroCeiling = cap - reserved;

    // A generic (non-MacroAgent) caller — e.g. FundamentalAgent — is denied once it would dip
    // into the reserved slice, even though the shared daily counter has room left overall.
    expect(await AlphaVantageBudget.tryConsume(nonMacroCeiling, undefined, 'FundamentalAgent')).toBe(true);
    expect(await AlphaVantageBudget.tryConsume(1, undefined, 'FundamentalAgent')).toBe(false);

    // MacroAgent can still consume out of that same reserved slice.
    expect(await AlphaVantageBudget.tryConsume(reserved, undefined, 'MacroAgent')).toBe(true);
    expect(await AlphaVantageBudget.remaining()).toBe(0);
  });

  it('2026-10-12 (M4): lock-timeout releases the CALLER but the chain still serializes on the real fn() settlement - no lost-update race on the budget counter', async () => {
    // 2026-10-12 contract change (M4): advancing the shared chain on the CALLER's
    // lock-timeout rejection let the next enqueued operation's read-modify-write run
    // concurrently with the still-running write - both read the same `used`, both write
    // `used + count`, one increment is silently lost. The chain now advances only on the
    // UNDERLYING fn()'s real settlement, so the counter reflects actual fn() outcomes
    // only. Stated tradeoff: an fn() that NEVER settles now holds the chain (the old
    // 2026-08-18 starvation mode) instead of being skipped past - but the timed-out
    // caller still gets its loud error immediately.
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
      const p1 = AlphaVantageBudget.tryConsume(1);
      let p1Error: any = null;
      p1.catch((e) => { p1Error = e; });
      const p2 = AlphaVantageBudget.tryConsume(1);
      let p2Outcome: string | null = null;
      p2.then(
        (v) => { p2Outcome = `resolved:${v}`; },
        (e) => { p2Outcome = `rejected:${e?.message}`; },
      );

      // Past the lock timeout: caller #1 is released immediately with the loud error...
      await vi.advanceTimersByTimeAsync(tradingSafety.alphaVantageBudgetLockTimeoutMs + 100);
      expect(p1Error).toBeInstanceOf(Error);
      expect(p1Error.message).toMatch(/exceeded \d+ms/);

      // ...but caller #2 must NOT have run yet: the chain waits for fn #1's real
      // settlement, so the two read-modify-writes can never overlap. (On the old code
      // the chain advanced on p1's rejection and p2 would already be resolved here.)
      await vi.advanceTimersByTimeAsync(5000);
      expect(p2Outcome).toBeNull();

      // fn #1's real write lands (used=1); only then does the chain advance and fn #2 run.
      releaseFirst();
      vi.useRealTimers();
      expect(await p2).toBe(true);
      expect(p2Outcome).toBe('resolved:true');

      // Both real outcomes are reflected: used=2, not a lost update of used=1.
      const cap = tradingSafety.alphaVantageDailyRequestBudget;
      expect(await AlphaVantageBudget.remaining()).toBe(cap - 2);
    } finally {
      vi.useRealTimers();
      (ExternalDataCacheMod.ExternalDataCache as any).getStale = originalGetStale;
    }
  }, 15_000);
});
