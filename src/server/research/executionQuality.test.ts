import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('executionQuality (Institutional Transformation Mandate Part 16)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./executionQuality');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_exec_quality_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./executionQuality');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('returns an empty array when no trades with a real arrival_price and a real matching fill exist', async () => {
    const rows = await mod.buildExecutionQualityReport();
    expect(rows).toEqual([]);
    const summary = mod.summarizeExecutionQuality(rows);
    expect(summary.n).toBe(0);
    expect(summary.meanSlippageBps).toBeNull();
  });

  it('computes positive (worse) slippage for a BUY that filled above its arrival price', async () => {
    await db.insert(schema.trades).values({
      id: 'order-buy-1', symbol: 'EQAAPL', side: 'BUY', quantity: 10, price: 101, status: 'FILLED',
      timestamp: new Date().toISOString(), arrivalPrice: 100, submittedAt: '2026-09-13T14:00:00.000Z',
      quantStrategyId: 'MOMENTUM_BREAKOUT', executionEnvironment: 'PAPER',
    });
    await db.insert(schema.fills).values({
      orderId: 'order-buy-1', quantity: 10, price: 101, filledAt: '2026-09-13T14:00:02.000Z', cumulativeQuantity: 10,
    });

    const rows = await mod.buildExecutionQualityReport();
    const row = rows.find((r) => r.orderId === 'order-buy-1')!;
    expect(row).toBeDefined();
    expect(row.avgFillPrice).toBe(101);
    expect(row.slippagePerShare).toBeCloseTo(1, 5); // paid $1 more than arrival - bad for a BUY
    expect(row.slippageBps).toBeCloseTo(100, 1); // 1/100 * 10000
    expect(row.submissionToFirstFillMs).toBe(2000);
    expect(row.quantStrategyId).toBe('MOMENTUM_BREAKOUT');
  });

  it('computes positive (worse) slippage for a SELL that filled below its arrival price', async () => {
    await db.insert(schema.trades).values({
      id: 'order-sell-1', symbol: 'EQMSFT', side: 'SELL', quantity: 5, price: 199, status: 'FILLED',
      timestamp: new Date().toISOString(), arrivalPrice: 200,
    });
    await db.insert(schema.fills).values({
      orderId: 'order-sell-1', quantity: 5, price: 199, filledAt: new Date().toISOString(), cumulativeQuantity: 5,
    });

    const rows = await mod.buildExecutionQualityReport();
    const row = rows.find((r) => r.orderId === 'order-sell-1')!;
    expect(row.slippagePerShare).toBeCloseTo(1, 5); // received $1 less than arrival - bad for a SELL
    expect(row.slippageBps).toBeCloseTo(50, 1); // 1/200 * 10000
  });

  it('weight-averages multiple partial fills for the same order', async () => {
    await db.insert(schema.trades).values({
      id: 'order-partial-1', symbol: 'EQGOOG', side: 'BUY', quantity: 10, price: 50, status: 'PARTIALLY_FILLED',
      timestamp: new Date().toISOString(), arrivalPrice: 50,
    });
    await db.insert(schema.fills).values([
      { orderId: 'order-partial-1', quantity: 6, price: 50, filledAt: new Date().toISOString(), cumulativeQuantity: 6 },
      { orderId: 'order-partial-1', quantity: 4, price: 51, filledAt: new Date().toISOString(), cumulativeQuantity: 10 },
    ]);

    const rows = await mod.buildExecutionQualityReport();
    const row = rows.find((r) => r.orderId === 'order-partial-1')!;
    // (6*50 + 4*51) / 10 = 50.4
    expect(row.avgFillPrice).toBeCloseTo(50.4, 5);
    expect(row.filledQuantity).toBe(10);
  });

  it('excludes a trade with no arrival_price (legacy row) even if it has a real fill', async () => {
    await db.insert(schema.trades).values({
      id: 'order-legacy-1', symbol: 'EQLEGACY', side: 'BUY', quantity: 1, price: 10, status: 'FILLED',
      timestamp: new Date().toISOString(), // arrivalPrice intentionally omitted -> null
    });
    await db.insert(schema.fills).values({
      orderId: 'order-legacy-1', quantity: 1, price: 10, filledAt: new Date().toISOString(), cumulativeQuantity: 1,
    });

    const rows = await mod.buildExecutionQualityReport();
    expect(rows.some((r) => r.orderId === 'order-legacy-1')).toBe(false);
  });

  it('excludes a trade with an arrival_price but no matching fills row - never estimates', async () => {
    await db.insert(schema.trades).values({
      id: 'order-nofill-1', symbol: 'EQNOFILL', side: 'BUY', quantity: 1, price: 10, status: 'PENDING',
      timestamp: new Date().toISOString(), arrivalPrice: 10,
    });

    const rows = await mod.buildExecutionQualityReport();
    expect(rows.some((r) => r.orderId === 'order-nofill-1')).toBe(false);
  });

  it('summarizeExecutionQuality computes a real mean/median across all included rows', async () => {
    const rows = await mod.buildExecutionQualityReport();
    const summary = mod.summarizeExecutionQuality(rows);
    expect(summary.n).toBe(rows.length);
    expect(summary.n).toBeGreaterThanOrEqual(3);
    expect(summary.meanSlippageBps).not.toBeNull();
    expect(summary.positiveSlippageCount + summary.negativeSlippageCount).toBeLessThanOrEqual(summary.n);
  });

  it('formatExecutionQualityReport renders a readable text table with NO_DATA guard', () => {
    const emptySummary = mod.summarizeExecutionQuality([]);
    expect(mod.formatExecutionQualityReport([], emptySummary)).toContain('NO_DATA');
  });
});
