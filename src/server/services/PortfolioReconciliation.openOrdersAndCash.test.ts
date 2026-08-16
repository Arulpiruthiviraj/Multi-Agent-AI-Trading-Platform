import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * Phase 1, item 4 (ARGUS_SAFETY_HARDENING_REPORT.md) - real coverage for the reconciliation
 * expansion beyond positions: open orders and account-level cash/buying-power/equity consistency.
 * The current audit (FINAL_ANALYSIS.md Section 30.12) found these three were entirely
 * unreconciled. Real isolated temp SQLite DB, real BrokerManager (InternalPaperBroker default),
 * no per-module mocks - only the broker's own portfolio()/orders() responses are monkey-patched,
 * matching the established pattern in PortfolioReconciliation.test.ts.
 */
describe('PortfolioReconciliationWorker - open orders and account consistency (Phase 1)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let portfolioReconciliationWorker: any;
  let tradingEngine: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_reconcile_orders_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ tradingEngine } = await import('../engines/TradingEngine'));
    ({ portfolioReconciliationWorker } = await import('./PortfolioReconciliation'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('a real broker open order with no matching local trades row is flagged as OPEN_ORDER_MISSING_LOCALLY', async () => {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const broker = BrokerManager.getInstance().getActiveBroker();
    const originalOrders = broker.orders.bind(broker);
    (broker as any).orders = async () => [
      ...(await originalOrders()),
      { id: 'phantom-order-1', symbol: 'ORPHAN', side: 'BUY', type: 'MARKET', status: 'PENDING', quantity: 10, filledQuantity: 0, price: 100, createdAt: new Date(), updatedAt: new Date() },
    ];

    await portfolioReconciliationWorker.reconcile();

    const events = await db.select().from(schema.reconciliationEvents);
    const last = events[events.length - 1];
    expect(last.matches).toBe(false);
    const mismatches = JSON.parse(last.mismatches);
    expect(mismatches.some((m: any) => m.symbol === 'ORPHAN' && m.type === 'OPEN_ORDER_MISSING_LOCALLY')).toBe(true);

    (broker as any).orders = originalOrders;
  });

  it('a local non-terminal trades row whose brokerOrderId the broker no longer reports is flagged as OPEN_ORDER_MISSING_REMOTELY', async () => {
    await db.insert(schema.trades).values({
      id: 'ghost-local-1', symbol: 'GHOSTCO', side: 'BUY', quantity: 5, price: 50, status: 'PENDING',
      timestamp: new Date().toISOString(), reasoning: 'test', traceId: 'trace-ghost-1',
      requestId: 'ghost-local-1', submittedAt: new Date().toISOString(),
      brokerOrderId: 'broker-order-that-vanished',
    });

    await portfolioReconciliationWorker.reconcile();

    const events = await db.select().from(schema.reconciliationEvents);
    const last = events[events.length - 1];
    const mismatches = JSON.parse(last.mismatches);
    expect(mismatches.some((m: any) => m.symbol === 'GHOSTCO' && m.type === 'OPEN_ORDER_MISSING_REMOTELY')).toBe(true);
  });

  it('a broker reporting a non-finite equity/cash value is flagged ACCOUNT_INCONSISTENCY and pauses trading', async () => {
    await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'test setup', actor: 'test' });

    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const broker = BrokerManager.getInstance().getActiveBroker();
    const originalPortfolio = broker.portfolio.bind(broker);
    (broker as any).portfolio = async () => ({ cash: NaN, buyingPower: 1000, equity: 1000, positions: [] });

    await portfolioReconciliationWorker.reconcile();

    const events = await db.select().from(schema.reconciliationEvents);
    const last = events[events.length - 1];
    const mismatches = JSON.parse(last.mismatches);
    expect(mismatches.some((m: any) => m.type === 'ACCOUNT_INCONSISTENCY')).toBe(true);
    expect(tradingEngine.state.tradingState).toBe('TRADING_PAUSED');

    (broker as any).portfolio = originalPortfolio;
    await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'test cleanup', actor: 'test' });
  });

  it('a broker reporting equity that does not reconcile with cash+positions beyond tolerance is flagged ACCOUNT_INCONSISTENCY', async () => {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const broker = BrokerManager.getInstance().getActiveBroker();
    const originalPortfolio = broker.portfolio.bind(broker);
    // cash(1000) + positions(0) = 1000 expected, but equity claims 5000 - a $4000 drift, way past
    // both the $50 floor and 1% tolerance.
    (broker as any).portfolio = async () => ({ cash: 1000, buyingPower: 1000, equity: 5000, positions: [] });

    await portfolioReconciliationWorker.reconcile();

    const events = await db.select().from(schema.reconciliationEvents);
    const last = events[events.length - 1];
    const mismatches = JSON.parse(last.mismatches);
    const accountMismatch = mismatches.find((m: any) => m.type === 'ACCOUNT_INCONSISTENCY');
    expect(accountMismatch).toBeTruthy();
    expect(accountMismatch.approxDollarImpact).toBeCloseTo(4000, 0);

    (broker as any).portfolio = originalPortfolio;
  });

  it('a consistent broker response (cash+positions ~= equity, within tolerance) produces NO account mismatch', async () => {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const broker = BrokerManager.getInstance().getActiveBroker();
    const originalPortfolio = broker.portfolio.bind(broker);
    (broker as any).portfolio = async () => ({ cash: 10000, buyingPower: 10000, equity: 10010, positions: [] }); // $10 drift - well within the $50 floor

    await portfolioReconciliationWorker.reconcile();

    const events = await db.select().from(schema.reconciliationEvents);
    const last = events[events.length - 1];
    if (last.mismatches) {
      const mismatches = JSON.parse(last.mismatches);
      expect(mismatches.some((m: any) => m.type === 'ACCOUNT_INCONSISTENCY')).toBe(false);
    }

    (broker as any).portfolio = originalPortfolio;
  });

  it('a broker FILLED order with no matching local trades.brokerOrderId is flagged FILLED_ORDER_MISSING_LOCALLY', async () => {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const broker = BrokerManager.getInstance().getActiveBroker();
    const originalOrders = broker.orders.bind(broker);
    (broker as any).orders = async () => [
      ...(await originalOrders()),
      { id: 'filled-orphan-1', symbol: 'FILLGAP', side: 'BUY', type: 'MARKET', status: 'FILLED', quantity: 8, filledQuantity: 8, price: 50, averageFillPrice: 50, createdAt: new Date(), updatedAt: new Date() },
    ];

    await portfolioReconciliationWorker.reconcile();

    const events = await db.select().from(schema.reconciliationEvents);
    const last = events[events.length - 1];
    expect(last.matches).toBe(false);
    const mismatches = JSON.parse(last.mismatches);
    expect(mismatches.some((m: any) => m.symbol === 'FILLGAP' && m.type === 'FILLED_ORDER_MISSING_LOCALLY')).toBe(true);

    (broker as any).orders = originalOrders;
  });
});
