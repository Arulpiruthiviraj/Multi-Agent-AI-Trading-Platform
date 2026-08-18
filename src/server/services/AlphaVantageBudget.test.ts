import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
});
