import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('strategyProfitabilityReport', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./strategyProfitabilityReport');
  let seq = 0;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_strategy_profitability_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./strategyProfitabilityReport');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  function nextId(): string {
    seq += 1;
    return `t-${seq}`;
  }

  /** Seeds one real, organic, FILLED BUY->SELL round-trip attributed to strategyId. */
  async function seedRoundTrip(strategyId: string, symbol: string, entryPrice: number, exitPrice: number, quantity: number, atIso: string) {
    const buyId = nextId();
    const sellId = nextId();
    await db.insert(schema.trades).values({
      id: buyId, symbol, side: 'BUY', quantity, price: entryPrice, status: 'FILLED',
      timestamp: atIso, filledAt: atIso, quantStrategyId: strategyId,
    });
    const exitIso = new Date(new Date(atIso).getTime() + 60_000).toISOString();
    const profitLoss = (exitPrice - entryPrice) * quantity;
    await db.insert(schema.trades).values({
      id: sellId, symbol, side: 'SELL', quantity, price: exitPrice, status: 'FILLED',
      timestamp: exitIso, filledAt: exitIso, profitLoss,
    });
  }

  it('reports INSUFFICIENT_DATA for a strategy with fewer than 5 real closed round-trips', async () => {
    await seedRoundTrip('THIN_STRATEGY', 'AAPL', 100, 101, 10, '2026-01-01T10:00:00.000Z');
    const rows = await mod.buildStrategyProfitabilityReport();
    const row = rows.find((r) => r.strategyId === 'THIN_STRATEGY')!;
    expect(row.tradeCount).toBe(1);
    expect(row.status).toBe('INSUFFICIENT_DATA');
  });

  it('computes real net P&L, profit factor, and expectancy from real fill prices - a strategy can be "right" on direction and still lose money after real execution', async () => {
    // 6 winners of $10 each, 4 losers of $30 each - net negative despite a 60% "win rate".
    for (let i = 0; i < 6; i++) {
      await seedRoundTrip('COSTLY_STRATEGY', 'MSFT', 100, 101, 10, `2026-01-0${i + 1}T10:00:00.000Z`);
    }
    for (let i = 0; i < 4; i++) {
      await seedRoundTrip('COSTLY_STRATEGY', 'MSFT', 100, 97, 10, `2026-01-1${i}T10:00:00.000Z`);
    }
    const rows = await mod.buildStrategyProfitabilityReport();
    const row = rows.find((r) => r.strategyId === 'COSTLY_STRATEGY')!;
    expect(row.tradeCount).toBe(10);
    expect(row.winCount).toBe(6);
    expect(row.winRate).toBeCloseTo(0.6, 5);
    // 6 trades * (101-100)*10 = +60 gross win; 4 trades * (97-100)*10 = -120 gross loss; net = -60.
    expect(row.netPnl).toBeCloseTo(-60, 2);
    expect(row.status).toBe('NET_NEGATIVE');
    expect(row.profitFactor).toBeLessThan(1);
  });

  it('classifies a genuinely net-positive, high-confidence strategy correctly and computes a real drawdown', async () => {
    // 25 winners of $20, interleaved with 5 losers of $15 - net positive, enough trades for confidence.
    const dates: string[] = [];
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= 3; d++) {
        const mm = m < 10 ? `0${m}` : `${m}`;
        const dd = d < 10 ? `0${d}` : `${d}`;
        dates.push(`2026-${mm}-${dd}T09:00:00.000Z`);
      }
    }
    let idx = 0;
    for (let i = 0; i < 25; i++) {
      await seedRoundTrip('SOLID_STRATEGY', 'NVDA', 200, 202, 10, dates[idx++]);
    }
    for (let i = 0; i < 5; i++) {
      await seedRoundTrip('SOLID_STRATEGY', 'NVDA', 200, 198.5, 10, dates[idx++]);
    }
    const rows = await mod.buildStrategyProfitabilityReport();
    const row = rows.find((r) => r.strategyId === 'SOLID_STRATEGY')!;
    expect(row.tradeCount).toBe(30);
    expect(row.netPnl).toBeGreaterThan(0);
    expect(row.status).toBe('NET_POSITIVE');
    expect(row.wilsonLower).not.toBeNull();
    expect(row.maxDrawdown).toBeGreaterThanOrEqual(0);
  });

  it('formatStrategyProfitabilityReport renders a readable table and never crashes on zero rows', () => {
    expect(mod.formatStrategyProfitabilityReport([])).toContain('no real organic closed round-trips');
  });
});
