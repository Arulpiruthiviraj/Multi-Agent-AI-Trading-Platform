import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
});
