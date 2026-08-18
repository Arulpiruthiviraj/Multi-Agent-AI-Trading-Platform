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
    portfolioReconciliationWorker.resetFaultDebounceForTests();
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

  it('hydrating a broker-only name is MATCH, not a MISSING_LOCALLY pause (GLD/NVDA flap)', async () => {
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
    expect(last.matches).toBe(true);
    expect(tradingEngine.state.tradingState).toBe('TRADING_ENABLED');
    const local = await db.select().from(schema.portfolio);
    expect(local.some((r: any) => r.symbol === 'NVDA' && r.quantity === 1)).toBe(true);
  });

  it('pauses only after two consecutive MISSING_REMOTELY cycles (not a one-off broker omission)', async () => {
    const { runtimeIntervals } = await import('../config/runtimeIntervals');
    const { tradingSafety } = await import('../config/tradingSafety');
    resetBootTimestampForTests(Date.now() - runtimeIntervals.reconciliationBootWarmupMs - 1);

    await db.insert(schema.portfolio).values({
      symbol: 'GLD',
      quantity: 1,
      averagePrice: 400,
      currentPrice: 403.38,
      lastUpdated: new Date().toISOString(),
      brokerSource: 'test',
    });

    await portfolioReconciliationWorker.reconcile();
    expect(tradingEngine.state.tradingState).toBe('TRADING_ENABLED');
    const afterFirst = await db.select().from(schema.portfolio);
    expect(afterFirst.find((r: any) => r.symbol === 'GLD')?.quantity).toBe(1);

    await portfolioReconciliationWorker.reconcile();
    expect(tradingEngine.state.tradingState).toBe('TRADING_PAUSED');
    const events = await db.select().from(schema.reconciliationEvents);
    const last = events[events.length - 1];
    expect(last.actionTaken).toBe('TRADING_PAUSED');
    const mismatches = JSON.parse(last.mismatches);
    expect(mismatches.some((m: any) => m.symbol === 'GLD' && m.type === 'MISSING_REMOTELY')).toBe(true);
    expect(tradingSafety.reconPauseConsecutiveMismatchCycles).toBe(2);

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
