import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Real integration test (isolated temp SQLite DB, same established pattern as
 * BacktestEngine.strategyBacktest.test.ts) for WalkForwardValidator - previously untested. Covers
 * both the original run()-backed mode and E5's new runStrategyBacktest()-backed mode
 * (BACKTEST_QUANT_HARDENING_ANALYSIS.md), proving the rolling train/test window split and the
 * real IS-vs-OOS aggregation work for both real backtest entry points, not just one.
 */
describe('WalkForwardValidator.run', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let walkForwardValidator: any;
  const originalKey = process.env.ALPACA_API_KEY;
  const originalSecret = process.env.ALPACA_SECRET_KEY;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_walkforward_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_SECRET_KEY = 'test-secret';

    ({ db, sqliteDb } = await import('../../db'));
    schema = await import('../../db/schema');
    ({ walkForwardValidator } = await import('./WalkForwardValidator'));

    await db.insert(schema.settings).values({ maxTradeSize: 5000, riskLevel: 'Balanced', maxOpenPositions: 10 });
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
    if (originalKey === undefined) delete process.env.ALPACA_API_KEY; else process.env.ALPACA_API_KEY = originalKey;
    if (originalSecret === undefined) delete process.env.ALPACA_SECRET_KEY; else process.env.ALPACA_SECRET_KEY = originalSecret;
  });

  afterEach(() => vi.unstubAllGlobals());

  function buildBars(symbol: string, days: number, startClose: number, dailyGrowth: number, startTs: number, dayMs: number) {
    const rows: any[] = [];
    let close = startClose;
    for (let i = 0; i < days; i++) {
      const high = close * 1.002, low = close * 0.97;
      rows.push({ id: `${symbol}:1Day:${startTs + i * dayMs}`, symbol, timeframe: '1Day', timestamp: startTs + i * dayMs, open: close * 0.99, high, low, close, volume: 500_000, source: 'alpaca' });
      close *= (1 + dailyGrowth);
    }
    return rows;
  }

  async function seedBars(rows: any[]) {
    for (const row of rows) await db.insert(schema.ohlcvBars).values(row);
  }

  function stubCleanFetch(seededRows: any[]) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('adjustment=raw')) return { ok: true, json: async () => ({ bars: [] }) };
      if (url.includes('adjustment=split')) {
        return { ok: true, json: async () => ({ bars: seededRows.map(r => ({ t: new Date(r.timestamp).toISOString(), c: r.close })) }) };
      }
      return { ok: true, json: async () => ({}) };
    }));
  }

  it('rejects when neither symbols nor strategyId+symbol are provided', async () => {
    await expect(walkForwardValidator.run({
      startDate: '2023-01-01', endDate: '2023-12-01', trainDays: 90, testDays: 30,
    })).rejects.toThrow(/Either symbols.*strategyId and symbol/);
  });

  it('rejects a date range too short for the requested windows', async () => {
    await expect(walkForwardValidator.run({
      symbols: ['WFCO'], startDate: '2023-01-01', endDate: '2023-02-01', trainDays: 90, testDays: 30,
    })).rejects.toThrow(/too short/);
  });

  it('splits a real date range into rolling windows via the original run()-backed mode and computes real IS/OOS averages', async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const startTs = new Date('2022-01-01').getTime();
    const rows = buildBars('WFCO', 500, 100, 0.003, startTs, dayMs);
    await seedBars(rows);
    stubCleanFetch(rows);

    const result = await walkForwardValidator.run({
      symbols: ['WFCO'],
      startDate: '2022-01-01',
      endDate: new Date(startTs + 500 * dayMs).toISOString().split('T')[0],
      // testDays must be >= BacktestEngine.run()'s own LOOKBACK (50) - each test window is
      // evaluated on its own bars only, matching a real out-of-sample constraint (see
      // WalkForwardConfig.testDays' own comment).
      trainDays: 120, testDays: 60, initialCash: 100000,
    });

    expect(result.periodCount).toBeGreaterThan(0);
    expect(result.periods.length).toBe(result.periodCount);
    for (const period of result.periods) {
      expect(period.train.status).toBe('COMPLETED');
      expect(period.test.status).toBe('COMPLETED');
      expect(typeof period.train.totalReturnPct).toBe('number');
      expect(typeof period.test.totalReturnPct).toBe('number');
      // Real non-overlapping, chronologically ordered windows - no look-ahead across periods.
      expect(new Date(period.trainEnd).getTime()).toBe(new Date(period.testStart).getTime());
      expect(new Date(period.trainStart).getTime()).toBeLessThan(new Date(period.trainEnd).getTime());
    }
    expect(typeof result.avgOutOfSampleReturnPct).toBe('number');
    expect(typeof result.inSampleVsOutOfSampleGapPct).toBe('number');
  });

  it('E5: splits into rolling windows via runStrategyBacktest()-backed mode when strategyId+symbol are given', async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const startTs = new Date('2022-01-01').getTime();
    const rows = buildBars('WFQUANT', 500, 100, 0.005, startTs, dayMs);
    await seedBars(rows);
    stubCleanFetch(rows);

    const result = await walkForwardValidator.run({
      strategyId: 'TREND_FOLLOWING', symbol: 'WFQUANT',
      startDate: '2022-01-01',
      endDate: new Date(startTs + 500 * dayMs).toISOString().split('T')[0],
      // testDays must be >= runStrategyBacktest()'s own REGIME_MIN_BARS (60) - see the sibling
      // run()-backed test's comment for why.
      trainDays: 150, testDays: 70, initialCash: 100000,
    });

    expect(result.periodCount).toBeGreaterThan(0);
    for (const period of result.periods) {
      expect(period.train.status).toBe('COMPLETED');
      expect(period.train.strategyId).toBe('TREND_FOLLOWING');
      expect(period.test.strategyId).toBe('TREND_FOLLOWING');
      expect(typeof period.test.totalReturnPct).toBe('number');
    }
  });
});
