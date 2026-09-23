import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('tradeEconomicAttribution', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./tradeEconomicAttribution');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_trade_econ_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./tradeEconomicAttribution');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('returns empty when no real arrival/fill evidence exists', async () => {
    const rows = await mod.buildTradeEconomicAttributionReport();
    expect(rows).toEqual([]);
  });

  it('computes a real net P&L for a SELL leg on a known-zero-commission broker (Alpaca equity)', async () => {
    await db.insert(schema.trades).values({
      id: 'sell-alpaca-1', symbol: 'AAPL', side: 'SELL', quantity: 10, price: 149,
      status: 'FILLED', timestamp: '2026-09-23T14:00:00.000Z', arrivalPrice: 150,
      quantStrategyId: 'MOMENTUM_BREAKOUT', executionEnvironment: 'PAPER', brokerId: 'alpaca',
      profitLoss: 500, // real gross P&L already net of average entry cost basis
    });
    await db.insert(schema.fills).values({
      orderId: 'sell-alpaca-1', quantity: 10, price: 149, filledAt: '2026-09-23T14:00:01.000Z', cumulativeQuantity: 10,
    });

    const rows = await mod.buildTradeEconomicAttributionReport();
    const row = rows.find((r) => r.orderId === 'sell-alpaca-1')!;
    expect(row).toBeDefined();
    expect(row.grossPnl).toBe(500);
    expect(row.strategyId).toBe('MOMENTUM_BREAKOUT');
    expect(row.strategyFamily).toBe('BREAKOUT_VOLATILITY'); // MOMENTUM_BREAKOUT's real family
    expect(row.cost.commissionQuality).toBe('MEASURED'); // Alpaca equity - verified $0 fact
    expect(row.cost.commissionTotal).toBe(0);
    expect(row.netPnlQuality).toBe('MEASURED');
    // slippagePerShare = arrival(150) - avgFill(149) = 1 (SELL filled below arrival = worse = positive)
    // totalCostPerShare = 1 (slippage) + 0 (commission) = 1; over qty 10 = 10
    expect(row.netPnlAfterExitLegCostOnly).toBeCloseTo(500 - 10, 6);
  });

  it('leaves net P&L UNAVAILABLE (never a silent zero-cost assumption) for a SELL on a broker with unmeasured commission', async () => {
    await db.insert(schema.trades).values({
      id: 'sell-ibkr-1', symbol: 'MSFT', side: 'SELL', quantity: 5, price: 299,
      status: 'FILLED', timestamp: '2026-09-23T15:00:00.000Z', arrivalPrice: 300,
      executionEnvironment: 'PAPER', brokerId: 'ibkr_gateway', profitLoss: 200,
    });
    await db.insert(schema.fills).values({
      orderId: 'sell-ibkr-1', quantity: 5, price: 299, filledAt: '2026-09-23T15:00:01.000Z', cumulativeQuantity: 5,
    });

    const rows = await mod.buildTradeEconomicAttributionReport();
    const row = rows.find((r) => r.orderId === 'sell-ibkr-1')!;
    expect(row).toBeDefined();
    expect(row.grossPnl).toBe(200);
    expect(row.cost.commissionQuality).toBe('UNAVAILABLE');
    expect(row.netPnlQuality).toBe('UNAVAILABLE');
    expect(row.netPnlAfterExitLegCostOnly).toBeNull();
  });

  it('reports null grossPnl/netPnl for a BUY leg (no realized P&L yet), while still reporting its own cost', async () => {
    await db.insert(schema.trades).values({
      id: 'buy-alpaca-1', symbol: 'AAPL', side: 'BUY', quantity: 10, price: 101,
      status: 'FILLED', timestamp: '2026-09-23T13:00:00.000Z', arrivalPrice: 100,
      executionEnvironment: 'PAPER', brokerId: 'alpaca',
    });
    await db.insert(schema.fills).values({
      orderId: 'buy-alpaca-1', quantity: 10, price: 101, filledAt: '2026-09-23T13:00:01.000Z', cumulativeQuantity: 10,
    });

    const rows = await mod.buildTradeEconomicAttributionReport();
    const row = rows.find((r) => r.orderId === 'buy-alpaca-1')!;
    expect(row).toBeDefined();
    expect(row.grossPnl).toBeNull();
    expect(row.netPnlAfterExitLegCostOnly).toBeNull();
    expect(row.netPnlQuality).toBe('UNAVAILABLE');
    // The leg's own cost is still real and reportable even though there's no P&L to net yet.
    expect(row.cost.slippageQuality).toBe('MEASURED');
    expect(row.cost.commissionQuality).toBe('MEASURED'); // Alpaca equity zero-commission fact
  });

  it('formatTradeEconomicAttributionReport renders a readable table without throwing on empty input', () => {
    const emptySummary = mod.summarizeTradeEconomicAttribution([], 'PAPER_ORGANIC');
    expect(() => mod.formatTradeEconomicAttributionReport([], emptySummary)).not.toThrow();
    expect(emptySummary.totalGrossPnl).toBeNull();
    expect(emptySummary.totalNetPnlMeasuredOnly).toBeNull();
  });
});
