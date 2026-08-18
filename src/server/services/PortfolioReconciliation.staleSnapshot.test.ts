import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Reproduces the GLD/NVDA false MISSING_LOCALLY race: local portfolio upsert lands
 * while broker.portfolio() is in flight, then compare must not record a mismatch.
 * Also proves a genuine broker-only position still records MISSING_LOCALLY and pauses
 * after warmup.
 */
describe('PortfolioReconciliation stale-snapshot / in-flight upsert race', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let portfolioReconciliationWorker: any;
  let tradingEngine: any;
  let resetBootTimestampForTests: (ms?: number | null) => void;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_recon_race_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ tradingEngine } = await import('../engines/TradingEngine'));
    ({ portfolioReconciliationWorker } = await import('./PortfolioReconciliation'));
    ({ resetBootTimestampForTests } = await import('../core/startup'));
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    BrokerManager.getInstance().resetSyncStateForTests('READY');
  });

  beforeEach(async () => {
    await db.delete(schema.portfolio);
    await db.delete(schema.reconciliationEvents);
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    BrokerManager.getInstance().resetSyncStateForTests('READY');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('does not record false MISSING_LOCALLY when local write lands during broker.portfolio()', async () => {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const broker = BrokerManager.getInstance().getActiveBroker();
    const originalPortfolio = broker.portfolio.bind(broker);
    (broker as any).portfolio = async () => {
      await new Promise((r) => setTimeout(r, 60));
      await db.insert(schema.portfolio).values({
        symbol: 'GLD',
        quantity: 1,
        averagePrice: 400,
        currentPrice: 403.38,
        lastUpdated: new Date().toISOString(),
        brokerSource: broker.name,
      });
      const real = await originalPortfolio();
      return {
        ...real,
        positions: [...real.positions, { symbol: 'GLD', quantity: 1, entryPrice: 400, currentPrice: 403.38 }],
      };
    };

    await portfolioReconciliationWorker.reconcile();
    (broker as any).portfolio = originalPortfolio;

    const events = await db.select().from(schema.reconciliationEvents);
    const last = events[events.length - 1];
    const mismatches = last.mismatches ? JSON.parse(last.mismatches) : [];
    expect(mismatches.some((m: any) => m.symbol === 'GLD' && m.type === 'MISSING_LOCALLY')).toBe(false);
    expect(tradingEngine.state.tradingState).toBe('TRADING_ENABLED');
  });

  it('records genuine MISSING_LOCALLY and pauses after warmup when local is still empty on fresh re-read', async () => {
    const { runtimeIntervals } = await import('../config/runtimeIntervals');
    resetBootTimestampForTests(Date.now() - runtimeIntervals.reconciliationBootWarmupMs - 1);

    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const broker = BrokerManager.getInstance().getActiveBroker();
    const originalPortfolio = broker.portfolio.bind(broker);
    (broker as any).portfolio = async () => {
      const real = await originalPortfolio();
      return {
        ...real,
        positions: [...real.positions, { symbol: 'NVDA', quantity: 1, entryPrice: 120, currentPrice: 226.27 }],
      };
    };

    await portfolioReconciliationWorker.reconcile();
    (broker as any).portfolio = originalPortfolio;

    const events = await db.select().from(schema.reconciliationEvents);
    const last = events[events.length - 1];
    expect(last.matches).toBe(false);
    const mismatches = JSON.parse(last.mismatches);
    expect(mismatches.some((m: any) => m.symbol === 'NVDA' && m.type === 'MISSING_LOCALLY')).toBe(true);
    expect(tradingEngine.state.tradingState).toBe('TRADING_PAUSED');
    expect(last.actionTaken).toBe('TRADING_PAUSED');

    await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'test cleanup', actor: 'test' });
  });

  it('stamps checkedAt at position-compare time, not after a delayed broker.orders()', async () => {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const broker = BrokerManager.getInstance().getActiveBroker();
    const originalOrders = broker.orders.bind(broker);
    (broker as any).orders = async () => {
      await new Promise((r) => setTimeout(r, 250));
      return originalOrders();
    };

    const started = Date.now();
    await portfolioReconciliationWorker.reconcile();
    const ended = Date.now();
    (broker as any).orders = originalOrders;

    const events = await db.select().from(schema.reconciliationEvents);
    const last = events[events.length - 1];
    const checkedAtMs = Date.parse(last.checkedAt);
    expect(checkedAtMs).toBeGreaterThanOrEqual(started - 50);
    // orders() slept 250ms. If checkedAt were stamped after that call, it would sit near `ended`.
    expect(ended - checkedAtMs).toBeGreaterThanOrEqual(200);
  });
});
