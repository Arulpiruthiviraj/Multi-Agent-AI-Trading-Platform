import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * ARGUS MASTER IMPLEMENTATION PROGRAM, Workstream D2 (2026-10-01).
 */
describe('computeDailyPnlDistribution ($2,000 intraday PAPER program, D2)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./dailyPnlDistribution');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_pnl_dist_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./dailyPnlDistribution');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  beforeEach(() => {
    db.delete(schema.trades).run();
    db.delete(schema.sessionLifecycleSnapshots).run();
  });

  function sellTrade(id: string, date: string, pnl: number, strategyId = 'MOMENTUM_BREAKOUT') {
    return {
      id, symbol: 'AAPL', side: 'SELL', quantity: 10, price: 100, status: 'FILLED',
      timestamp: `${date}T15:00:00.000Z`, filledAt: `${date}T15:00:00.000Z`,
      executionEnvironment: 'PAPER', profitLoss: pnl, quantStrategyId: strategyId,
    };
  }

  function sessionSnapshot(date: string) {
    return {
      tradingDate: date, marketSession: 'REGULAR', appState: 'INTRADAY',
      evaluatedAt: `${date}T16:00:00.000Z`, createdAt: `${date}T16:00:00.000Z`,
    };
  }

  it('is honestly NO_DATA when zero closed trades exist - matches CLAUDE.md ground truth (organic PAPER P&L = 0)', async () => {
    const report = await mod.computeDailyPnlDistribution();
    expect(report.sessionsWithTrades).toBe(0);
    expect(report.meanNetPnlPerDay).toBeNull();
    expect(report.profitableSessionPct).toBeNull();
    expect(report.grossExpectancyPerTrade).toBeNull();
    expect(report.dataNote).toMatch(/NO_DATA/);
  });

  it('never fabricates costPerTrade/netExpectancyPerTrade as zero - they stay null even with real trade data', async () => {
    await db.insert(schema.trades).values(sellTrade('t1', '2026-09-10', 50));
    const report = await mod.computeDailyPnlDistribution();
    expect(report.costPerTrade).toBeNull();
    expect(report.netExpectancyPerTrade).toBeNull();
    expect(report.grossExpectancyPerTrade).toBe(50); // gross IS computable, unlike cost
  });

  it('collapses multiple strategies on the same day into one net session P&L', async () => {
    await db.insert(schema.trades).values([
      sellTrade('t1', '2026-09-10', 50, 'MOMENTUM_BREAKOUT'),
      sellTrade('t2', '2026-09-10', -20, 'RANGE_REVERSION'),
    ]);
    const report = await mod.computeDailyPnlDistribution();
    expect(report.sessionsWithTrades).toBe(1);
    expect(report.meanNetPnlPerDay).toBe(30); // 50 - 20, both strategies same day
    expect(report.bestDay?.tradingDate).toBe('2026-09-10');
  });

  it('computes zero-trade-session % honestly using session_lifecycle_snapshots as the real session universe, not just days with trades', async () => {
    await db.insert(schema.sessionLifecycleSnapshots).values([
      sessionSnapshot('2026-09-10'), sessionSnapshot('2026-09-11'), sessionSnapshot('2026-09-12'),
    ]);
    await db.insert(schema.trades).values(sellTrade('t1', '2026-09-10', 25));
    // 2026-09-11 and 2026-09-12 ran (real session snapshots exist) but had zero closed trades.

    const report = await mod.computeDailyPnlDistribution();
    expect(report.sessionsWithKnownActivity).toBe(3);
    expect(report.sessionsWithTrades).toBe(1);
    expect(report.zeroTradeSessions).toBe(2);
    expect(report.zeroTradeSessionPct).toBeCloseTo((2 / 3) * 100, 5);
  });

  it('a session with a real trade but no session_lifecycle_snapshots row still counts as known activity (the trade itself is proof)', async () => {
    await db.insert(schema.trades).values(sellTrade('t1', '2026-09-10', 25));
    const report = await mod.computeDailyPnlDistribution();
    expect(report.sessionsWithKnownActivity).toBe(1);
    expect(report.zeroTradeSessions).toBe(0);
  });

  it('computes real percentile/mean/median/profitable-session stats across multiple real sessions', async () => {
    await db.insert(schema.trades).values([
      sellTrade('t1', '2026-09-08', 100),
      sellTrade('t2', '2026-09-09', -50),
      sellTrade('t3', '2026-09-10', 25),
      sellTrade('t4', '2026-09-11', 25),
    ]);
    const report = await mod.computeDailyPnlDistribution();
    expect(report.sessionsWithTrades).toBe(4);
    expect(report.meanNetPnlPerDay).toBe((100 - 50 + 25 + 25) / 4);
    expect(report.profitableSessionPct).toBe(75); // 3 of 4 positive
    expect(report.losingSessionPct).toBe(25); // 1 of 4 negative
    expect(report.worstDay?.netPnl).toBe(-50);
    expect(report.bestDay?.netPnl).toBe(100);
  });

  it('flags sessions at or above the $20 research benchmark without treating it as an operational quota', async () => {
    await db.insert(schema.trades).values([
      sellTrade('t1', '2026-09-10', 20), // exactly at the benchmark
      sellTrade('t2', '2026-09-11', 19.99), // just under
      sellTrade('t3', '2026-09-12', 100),
    ]);
    const report = await mod.computeDailyPnlDistribution();
    expect(report.sessionsAtOrAboveTwentyDollarsPct).toBeCloseTo((2 / 3) * 100, 5);
  });

  it('computes max drawdown and longest losing streak across the real session sequence', async () => {
    await db.insert(schema.trades).values([
      sellTrade('t1', '2026-09-08', 50), // cumulative 50 (peak)
      sellTrade('t2', '2026-09-09', -20), // cumulative 30 (drawdown -20 from peak)
      sellTrade('t3', '2026-09-10', -10), // cumulative 20 (drawdown -30 from peak)
      sellTrade('t4', '2026-09-11', 5), // cumulative 25 (still below peak)
    ]);
    const report = await mod.computeDailyPnlDistribution();
    expect(report.maxDrawdownAcrossSessions).toBe(-30);
    expect(report.longestLosingStreakSessions).toBe(2); // 09-09 and 09-10 consecutive losses
  });

  it('respects sinceDate filtering consistently between the trade data and the session universe', async () => {
    await db.insert(schema.sessionLifecycleSnapshots).values([
      sessionSnapshot('2026-09-01'), sessionSnapshot('2026-09-15'),
    ]);
    await db.insert(schema.trades).values([
      sellTrade('t1', '2026-09-01', 10),
      sellTrade('t2', '2026-09-15', 20),
    ]);
    const report = await mod.computeDailyPnlDistribution('2026-09-10');
    expect(report.sessionsWithKnownActivity).toBe(1); // only 09-15 is >= sinceDate
    expect(report.sessionsWithTrades).toBe(1);
  });
});
