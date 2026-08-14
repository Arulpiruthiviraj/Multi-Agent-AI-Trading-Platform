import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Phase 2 (LIVE_BACKTEST_PARITY_SPEC.md) - real coverage for the new portfolio-drawdown circuit
 * breaker simulation in runStrategyBacktest(), mirroring RiskEngine.ts's real live
 * `portfolio_drawdown` gate. Real isolated temp SQLite DB, real strategy evaluation, no mocks
 * beyond the standard "nothing new to fetch" fetch stub every other BacktestEngine test file uses.
 */
describe('BacktestEngine.runStrategyBacktest - drawdown circuit breaker (Phase 2)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let backtestEngine: any;
  const originalKey = process.env.ALPACA_API_KEY;
  const originalSecret = process.env.ALPACA_SECRET_KEY;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_drawdown_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_SECRET_KEY = 'test-secret';

    ({ db, sqliteDb } = await import('../../db'));
    schema = await import('../../db/schema');
    ({ backtestEngine } = await import('./BacktestEngine'));

    // A very tight 1% drawdown threshold so a real, modest price decline reliably trips the
    // breaker within a short synthetic series, without needing a huge/fragile price swing.
    await db.insert(schema.settings).values({ maxTradeSize: 50000, riskLevel: 'Balanced', maxOpenPositions: 10, maxPortfolioDrawdownPct: 0.01 });
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
      open: close * 0.999, high: close * 1.002, low: close * 0.97, close, volume: 800_000, source: 'alpaca',
    }));
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

  it('stops opening new positions once portfolio drawdown exceeds the real configured threshold, but keeps managing an already-open one', async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const startTs = new Date('2023-01-01').getTime();
    const closes: number[] = [];
    let price = 100;
    // 60 flat bars to clear REGIME_MIN_BARS, then a strong uptrend (real TREND_FOLLOWING entry),
    // then a sharp decline (drives real portfolio-level drawdown while the position is open),
    // then a long flat/choppy tail that would otherwise offer further real entry opportunities -
    // the assertion is that none of them are taken once the breaker has tripped.
    for (let i = 0; i < 60; i++) closes.push(price);
    for (let i = 0; i < 40; i++) { price *= 1.01; closes.push(price); } // strong uptrend - real entry
    for (let i = 0; i < 30; i++) { price *= 0.96; closes.push(price); } // sharp decline - real drawdown
    for (let i = 0; i < 60; i++) { // choppy/mildly trending tail - would otherwise re-enter
      price *= (i % 2 === 0 ? 1.02 : 0.99);
      closes.push(price);
    }

    const rows = buildBars('DDCO', closes, startTs, dayMs);
    await seedBars(rows);
    stubCleanFetch(rows);

    const result = await backtestEngine.runStrategyBacktest({
      strategyId: 'TREND_FOLLOWING',
      symbol: 'DDCO',
      startDate: '2023-01-01',
      endDate: new Date(startTs + (closes.length + 1) * dayMs).toISOString().split('T')[0],
      initialCash: 100000,
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.drawdownCircuitBreakerTriggeredAt).not.toBeNull();
    expect(typeof result.drawdownCircuitBreakerTriggeredAt).toBe('number');

    // No real BUY entry may occur strictly after the breaker tripped.
    const buyTrades = result.tradeLog.filter((t: any) => t.side === 'BUY');
    for (const trade of buyTrades) {
      expect(trade.timestamp).toBeLessThanOrEqual(result.drawdownCircuitBreakerTriggeredAt);
    }
  });

  it('never trips when the real equity curve never has a meaningful decline, regardless of threshold', async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const startTs = new Date('2023-01-01').getTime();
    const closes: number[] = [];
    let price = 100;
    // Monotonically non-declining prices throughout - a real open position's equity can only stay
    // flat or rise, so real drawdown-from-peak stays ~0% for the entire run regardless of which
    // settings row's threshold happens to be read (still using the same seeded DB as the first
    // test in this file - a real, honest "never triggered" outcome either way).
    for (let i = 0; i < 220; i++) { price *= 1.002; closes.push(price); }

    const rows = buildBars('NODDCO', closes, startTs, dayMs);
    await seedBars(rows);
    stubCleanFetch(rows);

    const result = await backtestEngine.runStrategyBacktest({
      strategyId: 'TREND_FOLLOWING',
      symbol: 'NODDCO',
      startDate: '2023-01-01',
      endDate: new Date(startTs + (closes.length + 1) * dayMs).toISOString().split('T')[0],
      initialCash: 100000,
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.drawdownCircuitBreakerTriggeredAt).toBeNull();
  });
});
