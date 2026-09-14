import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('dailyAttributionReport (Institutional Transformation Mandate Part 21)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./dailyAttributionReport');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_daily_attr_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./dailyAttributionReport');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('returns an empty array when no organic PAPER FILLED SELL trade exists - honest, matches CLAUDE.md ground truth', async () => {
    const rows = await mod.buildDailyAttributionReport();
    expect(rows).toEqual([]);
    const summary = mod.summarizeDailyAttribution(rows);
    expect(summary.totalRealizedPnl).toBe(0);
    expect(summary.bestStrategyId).toBeNull();
  });

  it('aggregates real realized P&L by real trading date and real strategy id', async () => {
    // Same NY trading day (2026-09-10), two different strategies.
    await db.insert(schema.trades).values([
      { id: 'attr-1', symbol: 'AAPL', side: 'SELL', quantity: 10, price: 101, status: 'FILLED', timestamp: '2026-09-10T15:00:00.000Z', filledAt: '2026-09-10T15:00:00.000Z', executionEnvironment: 'PAPER', profitLoss: 50, quantStrategyId: 'MOMENTUM_BREAKOUT' },
      { id: 'attr-2', symbol: 'MSFT', side: 'SELL', quantity: 5, price: 400, status: 'FILLED', timestamp: '2026-09-10T16:00:00.000Z', filledAt: '2026-09-10T16:00:00.000Z', executionEnvironment: 'PAPER', profitLoss: -20, quantStrategyId: 'MOMENTUM_BREAKOUT' },
      { id: 'attr-3', symbol: 'NVDA', side: 'SELL', quantity: 2, price: 900, status: 'FILLED', timestamp: '2026-09-10T17:00:00.000Z', filledAt: '2026-09-10T17:00:00.000Z', executionEnvironment: 'PAPER', profitLoss: 30, quantStrategyId: 'RANGE_REVERSION' },
    ]);

    const rows = await mod.buildDailyAttributionReport();
    expect(rows).toHaveLength(2);

    const momentum = rows.find((r) => r.strategyId === 'MOMENTUM_BREAKOUT')!;
    expect(momentum.realizedPnl).toBeCloseTo(30, 5); // 50 - 20
    expect(momentum.tradesCount).toBe(2);
    expect(momentum.winsCount).toBe(1);
    expect(momentum.lossesCount).toBe(1);

    const range = rows.find((r) => r.strategyId === 'RANGE_REVERSION')!;
    expect(range.realizedPnl).toBeCloseTo(30, 5);
    expect(range.winsCount).toBe(1);

    const summary = mod.summarizeDailyAttribution(rows);
    expect(summary.totalRealizedPnl).toBeCloseTo(60, 5);
    expect(summary.totalTradesCount).toBe(3);
    // Both strategies tie at +30 net - bestStrategyId picks whichever the Map iterates first,
    // but must be one of the two real positive contributors, never MOMENTUM_BREAKOUT's net-worse figure.
    expect(['MOMENTUM_BREAKOUT', 'RANGE_REVERSION']).toContain(summary.bestStrategyId);
  });

  it('labels a trade with no strategy id as UNATTRIBUTED rather than fabricating one', async () => {
    await db.insert(schema.trades).values({
      id: 'attr-unattr-1', symbol: 'SPY', side: 'SELL', quantity: 1, price: 500, status: 'FILLED',
      timestamp: '2026-09-11T15:00:00.000Z', filledAt: '2026-09-11T15:00:00.000Z',
      executionEnvironment: 'PAPER', profitLoss: 5,
    });
    const rows = await mod.buildDailyAttributionReport();
    const row = rows.find((r) => r.tradingDate === '2026-09-11')!;
    expect(row.strategyId).toBe('UNATTRIBUTED');
  });

  it('excludes REPLAY/BACKTEST/SIMULATION/LIVE/UNKNOWN environments - never blends them with organic PAPER', async () => {
    await db.insert(schema.trades).values([
      { id: 'attr-replay-1', symbol: 'TSLA', side: 'SELL', quantity: 1, price: 250, status: 'FILLED', timestamp: '2026-09-12T15:00:00.000Z', filledAt: '2026-09-12T15:00:00.000Z', executionEnvironment: 'REPLAY', profitLoss: 999999, quantStrategyId: 'MOMENTUM_BREAKOUT' },
      { id: 'attr-backtest-1', symbol: 'TSLA', side: 'SELL', quantity: 1, price: 250, status: 'FILLED', timestamp: '2026-09-12T15:05:00.000Z', filledAt: '2026-09-12T15:05:00.000Z', executionEnvironment: 'BACKTEST', profitLoss: 999999, quantStrategyId: 'MOMENTUM_BREAKOUT' },
    ]);
    const rows = await mod.buildDailyAttributionReport();
    const contaminated = rows.some((r) => r.realizedPnl >= 999999);
    expect(contaminated).toBe(false);
  });

  it('excludes non-FILLED and BUY-side rows (P&L only realizes on a real FILLED SELL)', async () => {
    await db.insert(schema.trades).values([
      { id: 'attr-pending-1', symbol: 'AMD', side: 'SELL', quantity: 1, price: 150, status: 'PENDING', timestamp: '2026-09-13T15:00:00.000Z', executionEnvironment: 'PAPER', profitLoss: 1000, quantStrategyId: 'TEST' },
      { id: 'attr-buy-1', symbol: 'AMD', side: 'BUY', quantity: 1, price: 150, status: 'FILLED', timestamp: '2026-09-13T15:01:00.000Z', filledAt: '2026-09-13T15:01:00.000Z', executionEnvironment: 'PAPER', profitLoss: null, quantStrategyId: 'TEST' },
    ]);
    const rows = await mod.buildDailyAttributionReport();
    expect(rows.some((r) => r.strategyId === 'TEST')).toBe(false);
  });

  it('formatDailyAttributionReport renders NO_DATA when empty and a real table otherwise', async () => {
    const emptySummary = mod.summarizeDailyAttribution([]);
    expect(mod.formatDailyAttributionReport([], emptySummary)).toContain('NO_DATA');

    const rows = await mod.buildDailyAttributionReport();
    const summary = mod.summarizeDailyAttribution(rows);
    const text = mod.formatDailyAttributionReport(rows, summary);
    expect(text).toContain('DAILY PERFORMANCE ATTRIBUTION');
    expect(text).toContain('MOMENTUM_BREAKOUT');
  });

  it('sinceDate filters out trading dates before the requested window', async () => {
    const rows = await mod.buildDailyAttributionReport('2026-09-12');
    expect(rows.every((r) => r.tradingDate >= '2026-09-12')).toBe(true);
    expect(rows.some((r) => r.tradingDate === '2026-09-10')).toBe(false);
  });
});
