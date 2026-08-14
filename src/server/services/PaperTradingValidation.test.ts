import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Phase 10 (ARGUS_PRE_IMPLEMENTATION_BASELINE.md) - real coverage for the paper-trading report
 * aggregation, over real seeded trades/transactions/risk_assessments/reconciliation_events rows.
 */
describe('computePaperTradingReport (Phase 10)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let computePaperTradingReport: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_papertrading_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ computePaperTradingReport } = await import('./PaperTradingValidation'));

    await db.insert(schema.transactions).values([
      { id: 'tx-1', symbol: 'AAPL', openedAt: new Date().toISOString(), status: 'RISK_REJECTED', finalDecision: 'BUY' },
      { id: 'tx-2', symbol: 'MSFT', openedAt: new Date().toISOString(), status: 'FILLED', finalDecision: 'BUY' },
      { id: 'tx-3', symbol: 'AMD', openedAt: new Date().toISOString(), status: 'NO_CONSENSUS' },
    ]);
    await db.insert(schema.riskAssessments).values([
      { traceId: 't1', transactionId: 'tx-1', symbol: 'AAPL', side: 'BUY', approved: false, rejectionGate: 'daily_loss', maxQuantity: 0, createdAt: new Date().toISOString() },
      { traceId: 't2', transactionId: 'tx-2', symbol: 'MSFT', side: 'BUY', approved: true, maxQuantity: 5, createdAt: new Date().toISOString() },
    ]);
    // Real closed-trade P&L sequence: 3 wins, 2 losses.
    await db.insert(schema.trades).values([
      { id: 'buy-1', symbol: 'MSFT', side: 'BUY', quantity: 5, price: 100, status: 'FILLED', timestamp: new Date().toISOString() },
      { id: 'sell-1', symbol: 'MSFT', side: 'SELL', quantity: 5, price: 110, status: 'FILLED', profitLoss: 50, timestamp: new Date().toISOString() },
      { id: 'sell-2', symbol: 'MSFT', side: 'SELL', quantity: 5, price: 105, status: 'FILLED', profitLoss: 25, timestamp: new Date().toISOString() },
      { id: 'sell-3', symbol: 'MSFT', side: 'SELL', quantity: 5, price: 90, status: 'FILLED', profitLoss: -50, timestamp: new Date().toISOString() },
      { id: 'sell-4', symbol: 'MSFT', side: 'SELL', quantity: 5, price: 95, status: 'FILLED', profitLoss: -25, timestamp: new Date().toISOString() },
      { id: 'sell-5', symbol: 'MSFT', side: 'SELL', quantity: 5, price: 108, status: 'FILLED', profitLoss: 40, timestamp: new Date().toISOString() },
      // Not a closed trade - must be excluded from win-rate/Sharpe math.
      { id: 'pending-1', symbol: 'AAPL', side: 'BUY', quantity: 1, price: 0, status: 'PENDING', timestamp: new Date().toISOString() },
    ]);
    await db.insert(schema.reconciliationEvents).values([
      { checkedAt: new Date().toISOString(), broker: 'Test', matches: true },
      { checkedAt: new Date().toISOString(), broker: 'Test', matches: false, mismatches: '[]' },
    ]);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('computes real transaction/risk breakdowns from the actual seeded rows', async () => {
    const report = await computePaperTradingReport();
    expect(report.totalTransactions).toBe(3);
    expect(report.transactionsByStatus).toEqual({ RISK_REJECTED: 1, FILLED: 1, NO_CONSENSUS: 1 });
    expect(report.totalRiskAssessments).toBe(2);
    expect(report.riskApprovedCount).toBe(1);
    expect(report.riskRejectedCount).toBe(1);
    expect(report.riskRejectionsByGate).toEqual({ daily_loss: 1 });
  });

  it('computes real win rate/profit factor/expectancy from only real closed (FILLED SELL) trades', async () => {
    const report = await computePaperTradingReport();
    expect(report.totalFilledTrades).toBe(5);
    expect(report.winRatePct).toBe(60); // 3 of 5
    expect(report.profitFactor).toBeCloseTo((50 + 25 + 40) / (50 + 25), 2);
    expect(report.expectancy).toBeCloseTo((50 + 25 - 50 - 25 + 40) / 5, 2);
  });

  it('flags statisticallyMeaningful=false below the real 30-trade floor, with an honest reason', async () => {
    const report = await computePaperTradingReport();
    expect(report.statisticallyMeaningful).toBe(false);
    expect(report.note).toContain('below the 30-trade floor');
  });

  it('counts real reconciliation events and mismatches', async () => {
    const report = await computePaperTradingReport();
    expect(report.reconciliationEventCount).toBe(2);
    expect(report.reconciliationMismatchCount).toBe(1);
  });
});
