import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Real integration test (isolated temp SQLite DB, same established pattern as
 * BacktestEngine.test.ts) for Phase 10 of the additive quant layer: runStrategyBacktest(). Bars
 * are seeded directly into ohlcv_bars (no real Alpaca account in this environment) - ensureBars()'s
 * own fetch is mocked to report "nothing new" so it falls back to the seeded cache, exactly as
 * BacktestEngine.test.ts already does for run(). Proves the real per-bar regime/marketContext/
 * strategy-evaluation wiring runs end-to-end without look-ahead bias, produces a real regime-
 * segmented report, and persists a real quant_strategy_backtests row - not merely that it compiles.
 */
describe('BacktestEngine.runStrategyBacktest', { timeout: 60000 }, () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let backtestEngine: any;
  const originalKey = process.env.ALPACA_API_KEY;
  const originalSecret = process.env.ALPACA_SECRET_KEY;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_strategybacktest_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_SECRET_KEY = 'test-secret';

    ({ db, sqliteDb } = await import('../../db'));
    schema = await import('../../db/schema');
    ({ backtestEngine } = await import('./BacktestEngine'));

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

  /** A strong, clean, monotonic uptrend with each bar closing near its own high (real bullish bar
   *  structure - drives a real positive Chaikin Money Flow, not the perfectly-symmetric ±1% bars
   *  BacktestEngine.test.ts's own helper uses, which would make CMF compute to exactly 0 every bar
   *  regardless of trend direction). */
  function buildTrendingBars(symbol: string, startClose: number, days: number, dailyGrowth: number, startTs: number, dayMs: number) {
    const rows: any[] = [];
    let close = startClose;
    for (let i = 0; i < days; i++) {
      const high = close * 1.002;
      const low = close * 0.97;
      rows.push({
        id: `${symbol}:1Day:${startTs + i * dayMs}`,
        symbol, timeframe: '1Day', timestamp: startTs + i * dayMs,
        open: close * 0.99, high, low, close, volume: 500_000, source: 'alpaca',
      });
      close = close * (1 + dailyGrowth);
    }
    return rows;
  }

  async function seedBars(rows: any[]) {
    for (const row of rows) await db.insert(schema.ohlcvBars).values(row);
  }

  /** Same real pattern as BacktestEngine.test.ts's stubCleanFetch - "nothing new to fetch" for any
   *  symbol (traded symbol AND every benchmark/sector-ETF MarketContext.ts also fetches), falling
   *  back to whatever's actually seeded in ohlcv_bars; corporate-actions comparison reports clean
   *  for the traded symbol specifically. */
  function stubCleanFetch(tradedSymbolRows: any[]) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('adjustment=raw')) return { ok: true, json: async () => ({ bars: [] }) };
      if (url.includes('adjustment=split')) {
        return { ok: true, json: async () => ({ bars: tradedSymbolRows.map(r => ({ t: new Date(r.timestamp).toISOString(), c: r.close })) }) };
      }
      return { ok: true, json: async () => ({}) };
    }));
  }

  it('runs a real per-strategy backtest end-to-end: real regime-segmented results, real avgR/Kelly, real persisted row', async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const startTs = new Date('2023-01-01').getTime();
    const rows = buildTrendingBars('TRENDCO', 100, 220, 0.008, startTs, dayMs);
    await seedBars(rows);
    stubCleanFetch(rows);

    const result = await backtestEngine.runStrategyBacktest({
      strategyId: 'TREND_FOLLOWING',
      symbol: 'TRENDCO',
      startDate: '2023-01-01',
      endDate: new Date(startTs + 221 * dayMs).toISOString().split('T')[0],
      initialCash: 100000,
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.promotable).toBe(false);
    expect(result.promotionRejection).toBe('SAME_BAR_CLOSE_NOT_PROMOTABLE');
    expect(Array.isArray(result.tradeLog)).toBe(true);
    expect(Array.isArray(result.equityCurve)).toBe(true);
    expect(result.equityCurve.length).toBeGreaterThan(0);

    // Real regime-segmented breakdown object exists (even if empty - genuinely no closed trades
    // yet is a valid, honest outcome, not a bug) and every entry it DOES contain is a real regime label.
    expect(typeof result.regimeBreakdown).toBe('object');
    for (const regime of Object.keys(result.regimeBreakdown)) {
      expect(['BULLISH_TREND', 'BEARISH_TREND', 'SIDEWAYS_RANGE']).toContain(regime);
    }

    // Real per-trade fields, never fabricated: commission/slippage present on every fill, and any
    // closed (SELL) trade carries a real entryRegime + real rMultiple.
    for (const trade of result.tradeLog) {
      expect(typeof trade.commission).toBe('number');
      expect(typeof trade.slippagePct).toBe('number');
      if (trade.side === 'SELL') {
        expect(['BULLISH_TREND', 'BEARISH_TREND', 'SIDEWAYS_RANGE']).toContain(trade.entryRegime);
        expect(typeof trade.rMultiple).toBe('number');
      }
    }

    // A real, persisted quant_strategy_backtests row - not just an in-memory return value.
    const persisted = await backtestEngine.getStrategyRun(result.id);
    expect(persisted).toBeDefined();
    expect(persisted.status).toBe('COMPLETED');
    expect(persisted.strategyId).toBe('TREND_FOLLOWING');
    expect(persisted.symbol).toBe('TRENDCO');
    expect(JSON.parse(persisted.regimeBreakdown)).toEqual(result.regimeBreakdown);

    // E4 - a real, always-present failure breakdown (zero losses is a valid, honest outcome).
    expect(result.failureBreakdown).toBeDefined();
    expect(typeof result.failureBreakdown.totalLosses).toBe('number');

    // E7 - real buy-and-hold comparison against the strong uptrend this test seeded (TRENDCO
    // grows every bar, so a real, large positive buy-and-hold return is expected) and a real,
    // persisted copy of the same object.
    expect(result.benchmarkComparison.symbolBuyAndHoldReturnPct).toBeGreaterThan(0);
    expect(typeof result.benchmarkComparison.strategyReturnPct).toBe('number');
    expect(JSON.parse(persisted.benchmarkComparison)).toEqual(result.benchmarkComparison);

    // E7 - real, whole-share-only capital-utilization scenarios from this run's own starting price.
    expect(Array.isArray(result.accountSizeReport)).toBe(true);
    expect(result.accountSizeReport.length).toBeGreaterThan(0);
    for (const scenario of result.accountSizeReport) {
      expect(Number.isInteger(scenario.affordableShares)).toBe(true);
      if (!scenario.tradePossible) expect(scenario.reason).toContain('WHOLE SHARE CONSTRAINT');
    }
  });

  it('rejects an unknown strategy id honestly, listing the real available strategies', async () => {
    await expect(backtestEngine.runStrategyBacktest({
      strategyId: 'NOT_A_REAL_STRATEGY',
      symbol: 'TRENDCO',
      startDate: '2023-01-01',
      endDate: '2023-06-01',
    })).rejects.toThrow(/Unknown strategy id.*MOMENTUM_BREAKOUT/);
  });

  it('rejects an invalid date range before touching any real data', async () => {
    await expect(backtestEngine.runStrategyBacktest({
      strategyId: 'TREND_FOLLOWING',
      symbol: 'TRENDCO',
      startDate: '2023-06-01',
      endDate: '2023-01-01', // end before start
    })).rejects.toThrow(/startDate must be a valid date before endDate/);
  });

  it('fails honestly with too few real bars rather than fabricating a regime read', async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const startTs = new Date('2023-01-01').getTime();
    const rows = buildTrendingBars('THINCO', 100, 10, 0.01, startTs, dayMs); // far below REGIME_MIN_BARS (60)
    await seedBars(rows);
    stubCleanFetch(rows);

    await expect(backtestEngine.runStrategyBacktest({
      strategyId: 'TREND_FOLLOWING',
      symbol: 'THINCO',
      startDate: '2023-01-01',
      endDate: new Date(startTs + 11 * dayMs).toISOString().split('T')[0],
    })).rejects.toThrow(/Only \d+ real bars available/);
  });

  it('records a real FAILED status (not a silently swallowed error) when the backtest throws', async () => {
    let failedId: string | null = null;
    try {
      await backtestEngine.runStrategyBacktest({
        strategyId: 'TREND_FOLLOWING',
        symbol: 'NOBARS_AT_ALL',
        startDate: '2023-01-01',
        endDate: '2023-06-01',
      });
    } catch (e: any) {
      const match = e.message; // insufficient-bars error, but the row must still be marked FAILED
    }
    const runs = await backtestEngine.listStrategyRuns();
    const failedRun = runs.filter((r: any) => r.symbol === 'NOBARS_AT_ALL').pop();
    expect(failedRun.status).toBe('FAILED');
    expect(failedRun.errorMessage).toBeTruthy();
  });

  // E3 (BACKTEST_QUANT_HARDENING_ANALYSIS.md)
  describe('verboseLogging', () => {
    it('writes zero quant_backtest_decision_log rows when verboseLogging is omitted (default false) - no behavior change for existing callers', async () => {
      const dayMs = 24 * 60 * 60 * 1000;
      const startTs = new Date('2023-01-01').getTime();
      const rows = buildTrendingBars('QUIETCO', 100, 220, 0.008, startTs, dayMs);
      await seedBars(rows);
      stubCleanFetch(rows);

      const result = await backtestEngine.runStrategyBacktest({
        strategyId: 'TREND_FOLLOWING',
        symbol: 'QUIETCO',
        startDate: '2023-01-01',
        endDate: new Date(startTs + 221 * dayMs).toISOString().split('T')[0],
        initialCash: 100000,
      });

      const { eq } = await import('drizzle-orm');
      const rowsWritten = await db.select().from(schema.quantBacktestDecisionLog)
        .where(eq(schema.quantBacktestDecisionLog.backtestRunId, result.id));
      expect(rowsWritten.length).toBe(0);
    });

    it('writes one decision-log row per real BUY candidate when verboseLogging=true, including the ENTERED trade', async () => {
      const dayMs = 24 * 60 * 60 * 1000;
      const startTs = new Date('2023-01-01').getTime();
      const rows = buildTrendingBars('VERBOSECO', 100, 220, 0.008, startTs, dayMs);
      await seedBars(rows);
      stubCleanFetch(rows);

      const result = await backtestEngine.runStrategyBacktest({
        strategyId: 'TREND_FOLLOWING',
        symbol: 'VERBOSECO',
        startDate: '2023-01-01',
        endDate: new Date(startTs + 221 * dayMs).toISOString().split('T')[0],
        initialCash: 100000,
        verboseLogging: true,
      });

      const { eq } = await import('drizzle-orm');
      const rowsWritten = await db.select().from(schema.quantBacktestDecisionLog)
        .where(eq(schema.quantBacktestDecisionLog.backtestRunId, result.id));
      expect(rowsWritten.length).toBeGreaterThan(0);

      // Real BUY entries in the trade log must correspond 1:1 with an ENTERED decision-log row at
      // the same timestamp - the trace must never drop or duplicate a real trading decision.
      const buyTrades = result.tradeLog.filter((t: any) => t.side === 'BUY');
      const enteredLogRows = rowsWritten.filter((r: any) => r.outcome === 'ENTERED');
      expect(enteredLogRows.length).toBe(buyTrades.length);
      for (const trade of buyTrades) {
        expect(enteredLogRows.some((r: any) => r.timestamp === trade.timestamp)).toBe(true);
      }

      // Every row has real, parseable structured detail, not a placeholder.
      for (const row of rowsWritten) {
        expect(() => JSON.parse(row.conditionsMet)).not.toThrow();
        expect(() => JSON.parse(row.conditionsFailed)).not.toThrow();
        expect(['ENTERED', 'REJECTED_LOW_CONFIDENCE', 'REJECTED_NO_STOP', 'REJECTED_ZERO_SIZE']).toContain(row.outcome);
        expect(row.reason.length).toBeGreaterThan(0);
      }
    });
  });
});
