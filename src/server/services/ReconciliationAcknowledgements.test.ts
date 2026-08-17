import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('PRE_EXISTING_RECONCILED acknowledgements', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let portfolioReconciliationWorker: any;
  let tradingEngine: any;
  let acknowledgePreExistingOrders: any;
  let revokeAcknowledgement: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_recon_ack_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ tradingEngine } = await import('../engines/TradingEngine'));
    ({ portfolioReconciliationWorker } = await import('./PortfolioReconciliation'));
    ({ acknowledgePreExistingOrders, revokeAcknowledgement } = await import('./ReconciliationAcknowledgements'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('unacked FILLED orphan still flags FILLED_ORDER_MISSING_LOCALLY', async () => {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const broker = BrokerManager.getInstance().getActiveBroker();
    const originalOrders = broker.orders.bind(broker);
    (broker as any).orders = async () => [
      {
        id: 'orphan-fill-unacked',
        symbol: 'GLD',
        side: 'BUY',
        type: 'MARKET',
        status: 'FILLED',
        quantity: 10,
        filledQuantity: 10,
        averageFillPrice: 180,
        price: 180,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    await portfolioReconciliationWorker.reconcile();
    const events = await db.select().from(schema.reconciliationEvents);
    const last = events[events.length - 1];
    const mismatches = JSON.parse(last.mismatches);
    expect(mismatches.some((m: any) => m.type === 'FILLED_ORDER_MISSING_LOCALLY' && m.symbol === 'GLD')).toBe(true);
    (broker as any).orders = originalOrders;
  });

  it('acked PRE_EXISTING_RECONCILED fill is excluded from pause impact', async () => {
    await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'test setup', actor: 'test' });

    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const broker = BrokerManager.getInstance().getActiveBroker();

    await acknowledgePreExistingOrders({
      broker: broker.name,
      actor: 'test:operator',
      reason: 'Pre-existing GLD fill reviewed — not Argus-generated',
      orders: [{
        brokerOrderId: 'orphan-fill-acked',
        symbol: 'GLD',
        side: 'BUY',
        quantity: 5,
        averageFillPrice: 175,
      }],
    });

    const originalOrders = broker.orders.bind(broker);
    const originalPortfolio = broker.portfolio.bind(broker);
    (broker as any).portfolio = async () => ({ cash: 100000, buyingPower: 100000, equity: 100000, positions: [] });
    (broker as any).orders = async () => [
      {
        id: 'orphan-fill-acked',
        symbol: 'GLD',
        side: 'BUY',
        type: 'MARKET',
        status: 'FILLED',
        quantity: 5,
        filledQuantity: 5,
        averageFillPrice: 175,
        price: 175,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    await portfolioReconciliationWorker.reconcile();
    const events = await db.select().from(schema.reconciliationEvents);
    const last = events[events.length - 1];
    if (last.mismatches) {
      const mismatches = JSON.parse(last.mismatches);
      expect(mismatches.some((m: any) => m.type === 'FILLED_ORDER_MISSING_LOCALLY' && m.symbol === 'GLD')).toBe(false);
    } else {
      expect(last.matches).toBe(true);
    }
    expect(tradingEngine.state.tradingState).toBe('TRADING_ENABLED');

    (broker as any).orders = originalOrders;
    (broker as any).portfolio = originalPortfolio;
  });

  it('new unacked orphan after ack still pauses when impact is significant', async () => {
    await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'test setup', actor: 'test' });

    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const broker = BrokerManager.getInstance().getActiveBroker();
    const originalOrders = broker.orders.bind(broker);
    const originalPortfolio = broker.portfolio.bind(broker);
    (broker as any).portfolio = async () => ({ cash: 100000, buyingPower: 100000, equity: 100000, positions: [] });
    (broker as any).orders = async () => [
      {
        id: 'orphan-fill-acked',
        symbol: 'GLD',
        side: 'BUY',
        type: 'MARKET',
        status: 'FILLED',
        quantity: 5,
        filledQuantity: 5,
        averageFillPrice: 175,
        price: 175,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'orphan-fill-new-nvda',
        symbol: 'NVDA',
        side: 'BUY',
        type: 'MARKET',
        status: 'FILLED',
        quantity: 2,
        filledQuantity: 2,
        averageFillPrice: 500,
        price: 500,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    await portfolioReconciliationWorker.reconcile();
    const events = await db.select().from(schema.reconciliationEvents);
    const last = events[events.length - 1];
    const mismatches = JSON.parse(last.mismatches);
    expect(mismatches.some((m: any) => m.symbol === 'NVDA' && m.type === 'FILLED_ORDER_MISSING_LOCALLY')).toBe(true);
    expect(mismatches.some((m: any) => m.symbol === 'GLD' && m.type === 'FILLED_ORDER_MISSING_LOCALLY')).toBe(false);
    expect(tradingEngine.state.tradingState).toBe('TRADING_PAUSED');

    (broker as any).orders = originalOrders;
    (broker as any).portfolio = originalPortfolio;
  });

  it('revoke restores FILLED_ORDER_MISSING_LOCALLY for that id', async () => {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const broker = BrokerManager.getInstance().getActiveBroker();
    await revokeAcknowledgement({
      broker: broker.name,
      brokerOrderId: 'orphan-fill-acked',
      actor: 'test:operator',
      reason: 'revoke for test',
    });
    await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'test setup', actor: 'test' });

    const originalOrders = broker.orders.bind(broker);
    const originalPortfolio = broker.portfolio.bind(broker);
    (broker as any).portfolio = async () => ({ cash: 100000, buyingPower: 100000, equity: 100000, positions: [] });
    (broker as any).orders = async () => [
      {
        id: 'orphan-fill-acked',
        symbol: 'GLD',
        side: 'BUY',
        type: 'MARKET',
        status: 'FILLED',
        quantity: 5,
        filledQuantity: 5,
        averageFillPrice: 175,
        price: 175,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    await portfolioReconciliationWorker.reconcile();
    const events = await db.select().from(schema.reconciliationEvents);
    const last = events[events.length - 1];
    const mismatches = JSON.parse(last.mismatches);
    expect(mismatches.some((m: any) => m.type === 'FILLED_ORDER_MISSING_LOCALLY' && m.symbol === 'GLD')).toBe(true);

    (broker as any).orders = originalOrders;
    (broker as any).portfolio = originalPortfolio;
  });
});
