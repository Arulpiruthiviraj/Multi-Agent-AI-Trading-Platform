import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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

  beforeEach(async () => {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    BrokerManager.getInstance().resetSyncStateForTests('READY');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  // Debounce added 2026-09-14 (forensic audit, "reconciliation racing active order processing"):
  // these three mismatch types now require the SAME fault to persist across
  // reconPauseConsecutiveMismatchCycles (2) CONSECUTIVE reconcile() cycles before being flagged -
  // matching the pre-existing position-level MISSING_LOCALLY/MISSING_REMOTELY protection (added
  // for the real GLD/NVDA flap incident). A single reconcile() call is a one-off fetch miss /
  // OMS-follow-up-lag, not yet a confirmed drift.
  it('a real broker open order with no matching local trades row is flagged as OPEN_ORDER_MISSING_LOCALLY only after it persists across 2 consecutive cycles, never on the first', async () => {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const broker = BrokerManager.getInstance().getActiveBroker();
    const originalOrders = broker.orders.bind(broker);
    (broker as any).orders = async () => [
      ...(await originalOrders()),
      { id: 'phantom-order-1', symbol: 'ORPHAN', side: 'BUY', type: 'MARKET', status: 'PENDING', quantity: 10, filledQuantity: 0, price: 100, createdAt: new Date(), updatedAt: new Date() },
    ];

    await portfolioReconciliationWorker.reconcile();
    let events = await db.select().from(schema.reconciliationEvents);
    let last = events[events.length - 1];
    let mismatches = last.mismatches ? JSON.parse(last.mismatches) : [];
    expect(mismatches.some((m: any) => m.symbol === 'ORPHAN' && m.type === 'OPEN_ORDER_MISSING_LOCALLY')).toBe(false); // NOT on the first cycle

    await portfolioReconciliationWorker.reconcile();
    events = await db.select().from(schema.reconciliationEvents);
    last = events[events.length - 1];
    expect(last.matches).toBe(false);
    mismatches = JSON.parse(last.mismatches);
    expect(mismatches.some((m: any) => m.symbol === 'ORPHAN' && m.type === 'OPEN_ORDER_MISSING_LOCALLY')).toBe(true); // confirmed on the second consecutive cycle

    (broker as any).orders = originalOrders;
  });

  it('a one-cycle-only OPEN_ORDER_MISSING_LOCALLY blip (resolved by the next cycle) is never flagged at all', async () => {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const broker = BrokerManager.getInstance().getActiveBroker();
    const originalOrders = broker.orders.bind(broker);
    (broker as any).orders = async () => [
      ...(await originalOrders()),
      { id: 'phantom-order-transient-1', symbol: 'TRANSIENT', side: 'BUY', type: 'MARKET', status: 'PENDING', quantity: 10, filledQuantity: 0, price: 100, createdAt: new Date(), updatedAt: new Date() },
    ];
    await portfolioReconciliationWorker.reconcile(); // fault count = 1

    (broker as any).orders = originalOrders; // the transient order is gone - broker "caught up" by cycle 2
    await portfolioReconciliationWorker.reconcile(); // fault does not recur - counter pruned

    (broker as any).orders = async () => [
      ...(await originalOrders()),
      { id: 'phantom-order-transient-1', symbol: 'TRANSIENT', side: 'BUY', type: 'MARKET', status: 'PENDING', quantity: 10, filledQuantity: 0, price: 100, createdAt: new Date(), updatedAt: new Date() },
    ];
    await portfolioReconciliationWorker.reconcile(); // fault count = 1 again (reset, not 2/carried-over)

    const events = await db.select().from(schema.reconciliationEvents);
    const last = events[events.length - 1];
    const mismatches = last.mismatches ? JSON.parse(last.mismatches) : [];
    expect(mismatches.some((m: any) => m.symbol === 'TRANSIENT' && m.type === 'OPEN_ORDER_MISSING_LOCALLY')).toBe(false);

    (broker as any).orders = originalOrders;
  });

  it('a local non-terminal trades row whose brokerOrderId the broker no longer reports is flagged as OPEN_ORDER_MISSING_REMOTELY only after 2 consecutive cycles, never on the first (the real "reconciliation racing OMS follow-up" scenario)', async () => {
    await db.insert(schema.trades).values({
      id: 'ghost-local-1', symbol: 'GHOSTCO', side: 'BUY', quantity: 5, price: 50, status: 'PENDING',
      timestamp: new Date().toISOString(), reasoning: 'test', traceId: 'trace-ghost-1',
      requestId: 'ghost-local-1', submittedAt: new Date().toISOString(),
      brokerOrderId: 'broker-order-that-vanished',
    });

    await portfolioReconciliationWorker.reconcile();
    let events = await db.select().from(schema.reconciliationEvents);
    let last = events[events.length - 1];
    let mismatches = last.mismatches ? JSON.parse(last.mismatches) : [];
    expect(mismatches.some((m: any) => m.symbol === 'GHOSTCO' && m.type === 'OPEN_ORDER_MISSING_REMOTELY')).toBe(false); // NOT on the first cycle - this is exactly the race a genuine OMS-follow-up-lag would produce

    await portfolioReconciliationWorker.reconcile();
    events = await db.select().from(schema.reconciliationEvents);
    last = events[events.length - 1];
    mismatches = JSON.parse(last.mismatches);
    expect(mismatches.some((m: any) => m.symbol === 'GHOSTCO' && m.type === 'OPEN_ORDER_MISSING_REMOTELY')).toBe(true); // confirmed on the second
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

  it('a broker FILLED order with no matching local trades.brokerOrderId is flagged FILLED_ORDER_MISSING_LOCALLY only after 2 consecutive cycles, never on the first', async () => {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const broker = BrokerManager.getInstance().getActiveBroker();
    const originalOrders = broker.orders.bind(broker);
    (broker as any).orders = async () => [
      ...(await originalOrders()),
      { id: 'filled-orphan-1', symbol: 'FILLGAP', side: 'BUY', type: 'MARKET', status: 'FILLED', quantity: 8, filledQuantity: 8, price: 50, averageFillPrice: 50, createdAt: new Date(), updatedAt: new Date() },
    ];

    await portfolioReconciliationWorker.reconcile();
    let events = await db.select().from(schema.reconciliationEvents);
    let last = events[events.length - 1];
    let mismatches = last.mismatches ? JSON.parse(last.mismatches) : [];
    expect(mismatches.some((m: any) => m.symbol === 'FILLGAP' && m.type === 'FILLED_ORDER_MISSING_LOCALLY')).toBe(false); // NOT on the first cycle

    await portfolioReconciliationWorker.reconcile();
    events = await db.select().from(schema.reconciliationEvents);
    last = events[events.length - 1];
    expect(last.matches).toBe(false);
    mismatches = JSON.parse(last.mismatches);
    expect(mismatches.some((m: any) => m.symbol === 'FILLGAP' && m.type === 'FILLED_ORDER_MISSING_LOCALLY')).toBe(true); // confirmed on the second consecutive cycle

    (broker as any).orders = originalOrders;
  });
});
