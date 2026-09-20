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

  it('does not treat unattributed PAPER or unknown legacy fills as organic paper evidence', async () => {
    const rows = await mod.buildExecutionQualityReport();
    const summary = mod.summarizeExecutionQuality(rows);
    expect(summary.n).toBe(0);
    expect(summary.excludedRowCount).toBe(rows.length);
    expect(summary.meanSlippageBps).toBeNull();
    expect(rows.find(r => r.orderId === 'order-buy-1')?.evidenceClass).toBe('PAPER_UNATTRIBUTED');
  });

  it('formatExecutionQualityReport renders a readable text table with NO_DATA guard', () => {
    const emptySummary = mod.summarizeExecutionQuality([]);
    expect(mod.formatExecutionQualityReport([], emptySummary)).toContain('NO_DATA');
  });

  it('separates organic, manual, replay and live evidence before applying the query limit', async () => {
    for (const [id, env, brokerId, agent, fillPrice, timestamp] of [
      ['organic', 'PAPER', 'ibkr_gateway', 'QuantEngine', 100.1, '2026-01-01T00:00:00Z'],
      ['manual', 'PAPER', 'ibkr_gateway', 'ManualOverride', 150, '2030-01-01T00:00:00Z'],
      ['replay', 'REPLAY', 'historical_replay', 'QuantEngine', 190, '2030-01-02T00:00:00Z'],
      ['live', 'LIVE', 'ibkr_gateway', 'QuantEngine', 160, '2030-01-03T00:00:00Z'],
      ['backtest', 'BACKTEST', 'research', 'QuantEngine', 180, '2030-01-04T00:00:00Z'],
      ['simulation', 'PAPER', 'internal_paper', 'QuantEngine', 170, '2030-01-05T00:00:00Z'],
    ] as const) {
      const tx = `quality-${id}`;
      await db.insert(schema.consensusDecisions).values({ transactionId: tx, symbol: 'AAPL', side: 'BUY', weightedConfidence: .8, threshold: .75, approved: true, createdAt: timestamp });
      await db.insert(schema.consensusEvidence).values({ transactionId: tx, agent, side: 'BUY', confidence: .8, weight: 1, agreed: true });
      await db.insert(schema.trades).values({ id: tx, transactionId: tx, traceId: `trace-AAPL-${id}`, symbol: 'AAPL', side: 'BUY', quantity: 1, price: fillPrice, arrivalPrice: 100, status: 'FILLED', timestamp, executionEnvironment: env, brokerId });
      await db.insert(schema.fills).values({ orderId: tx, quantity: 1, price: fillPrice, cumulativeQuantity: 1, filledAt: timestamp });
    }
    const scoped = await mod.buildExecutionQualityReport(1, 'PAPER_ORGANIC');
    expect(scoped.map(r => r.orderId)).toEqual(['quality-organic']);
    expect(scoped[0].evidenceClass).toBe('PAPER_ORGANIC');
    const all = await mod.buildExecutionQualityReport();
    expect(all.find(r => r.orderId === 'quality-manual')?.evidenceClass).toBe('PAPER_MANUAL');
    expect(all.find(r => r.orderId === 'quality-replay')?.evidenceClass).toBe('REPLAY');
    expect(all.find(r => r.orderId === 'quality-live')?.evidenceClass).toBe('LIVE');
    expect(all.find(r => r.orderId === 'quality-backtest')?.evidenceClass).toBe('BACKTEST');
    expect(all.find(r => r.orderId === 'quality-simulation')?.evidenceClass).toBe('SIMULATION');
    const summary = mod.summarizeExecutionQuality(all);
    expect(summary.n, JSON.stringify(all.map(r => [r.orderId, r.evidenceClass]))).toBe(1);
    expect(summary.meanSlippageBps).toBeCloseTo(10);
    expect(mod.summarizeExecutionQuality(all, 'REPLAY').meanSlippageBps).toBeCloseTo(9000);
  });
});
