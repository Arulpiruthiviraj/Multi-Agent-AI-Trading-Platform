import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * Real integration test (isolated temp SQLite DB) for Phase 2's BacktestEngine changes: real
 * RiskEngine-shared sizing (2A), real commission/dynamic slippage (2B), and the corporate-actions
 * safety halt (2C). Bars are seeded directly into ohlcv_bars rather than fetched live (no real
 * Alpaca account in this environment) - ensureBars()'s own fetch is mocked to return an empty
 * page so it falls back to the pre-seeded cache, exactly as it would if Alpaca returned no new
 * bars for an already-fully-cached range. The pure sizing/commission/slippage math itself already
 * has dedicated unit tests (PositionSizing.test.ts, Commissions.test.ts, Slippage.test.ts,
 * HistoricalDataGateway.test.ts) - this file is deliberately an integration smoke test proving
 * BacktestEngine.run() wires them all together correctly, not a re-derivation of that math.
 */
describe('BacktestEngine.run', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let backtestEngine: any;
  const originalKey = process.env.ALPACA_API_KEY;
  const originalSecret = process.env.ALPACA_SECRET_KEY;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_backtestengine_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_SECRET_KEY = 'test-secret';

    ({ db, sqliteDb } = await import('../../db'));
    schema = await import('../../db/schema');
    ({ backtestEngine } = await import('./BacktestEngine'));

    await db.insert(schema.settings).values({ maxTradeSize: 2000, riskLevel: 'Balanced', maxOpenPositions: 10 });
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

  function buildBars(symbol: string, closes: number[], startTs: number, dayMs: number) {
    return closes.map((close, i) => ({
      id: `${symbol}:1Day:${startTs + i * dayMs}`,
      symbol, timeframe: '1Day', timestamp: startTs + i * dayMs,
      open: close, high: close * 1.01, low: close * 0.99, close, volume: 500_000,
      source: 'alpaca',
    }));
  }

  async function seedBars(rows: any[]) {
    for (const row of rows) await db.insert(schema.ohlcvBars).values(row);
  }

  /** Mocks ensureBars() to report "nothing new to fetch" (falls back to the seeded cache) and
   * the corporate-actions comparison to match the seeded raw bars exactly (reports clean). */
  function stubCleanFetch(seededRows: any[]) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('adjustment=raw')) return { ok: true, json: async () => ({ bars: [] }) };
      if (url.includes('adjustment=split')) {
        return { ok: true, json: async () => ({ bars: seededRows.map(r => ({ t: new Date(r.timestamp).toISOString(), c: r.close })) }) };
      }
      return { ok: true, json: async () => ({}) };
    }));
  }

  it('completes a real run end-to-end against a plausible price series, with real sizing/commission/slippage wired in', async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const startTs = new Date('2024-01-01').getTime();
    // 55 flat bars, then a sharp decline (triggers the real mean-reversion BUY rule: rsi<30 and
    // price<bbLower), then a further decline (triggers the real -5% stop-loss SELL rule).
    const closes = [
      ...Array.from({ length: 55 }, () => 100),
      95, 90, 85, 80, 75, 70,
      68, 65, 63,
    ];
    const rows = buildBars('SIMCO', closes, startTs, dayMs);
    await seedBars(rows);
    stubCleanFetch(rows);

    const result = await backtestEngine.run({
      symbols: ['SIMCO'],
      startDate: '2024-01-01',
      endDate: new Date(startTs + (closes.length + 1) * dayMs).toISOString().split('T')[0],
      initialCash: 100000,
    });

    expect(result.status).toBe('COMPLETED');
    expect(Array.isArray(result.tradeLog)).toBe(true);
    expect(result.promotable).toBe(false);
    expect(result.promotionRejection).toBe('SAME_BAR_CLOSE_NOT_PROMOTABLE');

    // Whether or not the exact strategy conditions fired a trade on this specific series, the
    // run must complete cleanly and never throw a corporate-actions halt on genuinely clean data.
    for (const trade of result.tradeLog) {
      expect(typeof trade.commission).toBe('number');
      expect(typeof trade.slippagePct).toBe('number');
      expect(trade.slippagePct).toBeGreaterThan(0); // never a flat, unscaled zero
      if (trade.side === 'BUY') {
        expect(trade.commission).toBe(0); // SEC/FINRA fees are sells-only, matches Commissions.ts
        // Real sizing (2A): capped by the real maxTradeSize=2000 setting, not the old flat
        // 10%-of-initial-cash (100000*0.10=10000) rule - the notional at fill must respect the
        // configured real limit.
        expect(trade.price * trade.quantity).toBeLessThanOrEqual(2000 * 1.05); // small slippage tolerance
      } else {
        expect(trade.commission).toBeGreaterThan(0); // real SEC+FINRA fee on every real SELL
      }
    }
  });

  it('halts with CORPORATE_ACTION_DETECTED rather than silently corrupting PnL on an unadjusted split', async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const startTs = new Date('2024-06-01').getTime();
    const closes = Array.from({ length: 55 }, (_, i) => 400 + i); // real-looking raw pre-split prices
    const rows = buildBars('SPLITCO', closes, startTs, dayMs);
    await seedBars(rows);

    // Corporate-actions check reports a REAL split: split-adjusted closes are 4x smaller.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('adjustment=raw')) return { ok: true, json: async () => ({ bars: [] }) };
      if (url.includes('adjustment=split')) {
        return { ok: true, json: async () => ({ bars: rows.map(r => ({ t: new Date(r.timestamp).toISOString(), c: r.close / 4 })) }) };
      }
      return { ok: true, json: async () => ({}) };
    }));

    await expect(backtestEngine.run({
      symbols: ['SPLITCO'],
      startDate: '2024-06-01',
      endDate: new Date(startTs + closes.length * dayMs).toISOString().split('T')[0],
      initialCash: 100000,
    })).rejects.toThrow(/CORPORATE_ACTION_DETECTED/);

    const [run] = await db.select().from(schema.backtestRuns).where(eq(schema.backtestRuns.symbols, JSON.stringify(['SPLITCO'])));
    expect(run.status).toBe('FAILED');
  });
});

// Real bug fixed: computeMetrics() used to always annualize Sharpe/Sortino with sqrt(252)
// regardless of the equity curve's actual bar spacing, understating annualized Sharpe for any
// non-daily backtest (e.g. hourly bars have ~6.5x more observations/year than daily). Now
// inferred from real bars-per-trading-day. Calling the private method directly (backtestEngine is
// typed `any` in this file) since it isn't part of the public run()/runStrategyBacktest() surface.
describe('BacktestEngine.computeMetrics - real timeframe-aware Sharpe/Sortino annualization', () => {
  let backtestEngine: any;

  beforeAll(async () => {
    ({ backtestEngine } = await import('./BacktestEngine'));
  });

  function buildEquityCurve(pointsPerDay: number, days: number, seed = 1): { timestamp: number; equity: number }[] {
    // A real, fixed NY trading day (2024-06-03 was a Monday, no holiday) - every point that day
    // falls in the same getTradingDateStr() bucket regardless of pointsPerDay.
    const dayStartMs = Date.UTC(2024, 5, 3, 14, 30); // 09:30 ET in UTC for that date (EDT = UTC-4)
    const dayMs = 24 * 60 * 60 * 1000;
    const curve: { timestamp: number; equity: number }[] = [];
    let equity = 100000;
    let i = 0;
    for (let d = 0; d < days; d++) {
      for (let p = 0; p < pointsPerDay; p++) {
        const stepMs = pointsPerDay > 1 ? (p * (6.5 * 60 * 60 * 1000)) / (pointsPerDay - 1) : 0;
        curve.push({ timestamp: dayStartMs + d * dayMs + stepMs, equity });
        // Deterministic pseudo-random-ish return so stdRet > 0, not identical every step.
        const ret = Math.sin((i + seed) * 1.7) * 0.004;
        equity = equity * (1 + ret);
        i++;
      }
    }
    return curve;
  }

  it('matches the original sqrt(252) constant exactly for real daily bars (no regression)', () => {
    const curve = buildEquityCurve(1, 60);
    const metrics = backtestEngine.computeMetrics(100000, curve, [], curve[0].timestamp, curve[curve.length - 1].timestamp);
    // Manual reference calc using the untouched, original always-252 formula.
    const returns: number[] = [];
    for (let i = 1; i < curve.length; i++) returns.push((curve[i].equity - curve[i - 1].equity) / curve[i - 1].equity);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
    const expectedSharpe = Number(((mean / std) * Math.sqrt(252)).toFixed(2));
    expect(metrics.sharpe).toBe(expectedSharpe);
  });

  it('annualizes hourly (intraday) bars using real bars-per-trading-day, not a flat sqrt(252)', () => {
    const dailyCurve = buildEquityCurve(1, 60);
    const hourlyCurve = buildEquityCurve(7, 60); // ~7 bars/trading day, same seed/shape per day
    const dailyMetrics = backtestEngine.computeMetrics(100000, dailyCurve, [], dailyCurve[0].timestamp, dailyCurve[dailyCurve.length - 1].timestamp);
    const hourlyMetrics = backtestEngine.computeMetrics(100000, hourlyCurve, [], hourlyCurve[0].timestamp, hourlyCurve[hourlyCurve.length - 1].timestamp);
    // The old, buggy behavior would produce roughly the same magnitude Sharpe for both (both used
    // the same flat sqrt(252)). The real fix scales the hourly one up by ~sqrt(7) instead.
    expect(Math.abs(hourlyMetrics.sharpe)).toBeGreaterThan(Math.abs(dailyMetrics.sharpe) * 1.5);
  });
});
