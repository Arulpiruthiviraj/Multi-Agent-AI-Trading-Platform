import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Boot warmup guard: significant mismatches during the first reconciliationBootWarmupMs after
 * process start must sync positions but NOT auto-pause TRADING_ENABLED (Day-1 false-alarm fix).
 */
describe('PortfolioReconciliation boot warmup guard', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let portfolioReconciliationWorker: any;
  let tradingEngine: any;
  let resetBootTimestampForTests: (ms?: number | null) => void;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_recon_warmup_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ tradingEngine } = await import('../engines/TradingEngine'));
    ({ portfolioReconciliationWorker } = await import('./PortfolioReconciliation'));
    ({ resetBootTimestampForTests } = await import('../core/startup'));

    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    await db.insert(schema.settings).values({ maxTradeSize: 5000, riskLevel: 'Balanced', maxOpenPositions: 10 });
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    await BrokerManager.getInstance().initialize();
  });

  beforeEach(async () => {
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    const { armReconciliationBootWarmup } = await import('../core/startup');
    armReconciliationBootWarmup(Date.now());
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    BrokerManager.getInstance().resetSyncStateForTests('READY');
    portfolioReconciliationWorker.resetFaultDebounceForTests();
    await db.delete(schema.portfolio);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  async function injectBrokerMismatch(symbol = 'WARMUPTEST') {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const broker = BrokerManager.getInstance().getActiveBroker();
    const originalPortfolio = broker.portfolio.bind(broker);
    (broker as any).portfolio = async () => {
      const real = await originalPortfolio();
      return {
        ...real,
        positions: [...real.positions, { symbol, quantity: 100, entryPrice: 50, currentPrice: 50 }],
      };
    };
    await portfolioReconciliationWorker.reconcile();
    (broker as any).portfolio = originalPortfolio;
  }

  it('during boot warmup, three significant mismatches do NOT pause TRADING_ENABLED', async () => {
    for (let i = 0; i < 3; i++) {
      await injectBrokerMismatch(`WARMUP_${i}`);
      expect(tradingEngine.state.tradingState).toBe('TRADING_ENABLED');
    }
  });

  it('after boot warmup expires, two consecutive MISSING_REMOTELY cycles pause TRADING_ENABLED', async () => {
    const { runtimeIntervals } = await import('../config/runtimeIntervals');
    resetBootTimestampForTests(Date.now() - runtimeIntervals.reconciliationBootWarmupMs - 1);

    await db.insert(schema.portfolio).values({
      symbol: 'WARMUP_B',
      quantity: 100,
      averagePrice: 50,
      currentPrice: 50,
      lastUpdated: new Date().toISOString(),
      brokerSource: 'test',
    });
    await portfolioReconciliationWorker.reconcile();
    expect(tradingEngine.state.tradingState).toBe('TRADING_ENABLED');
    await portfolioReconciliationWorker.reconcile();
    expect(tradingEngine.state.tradingState).toBe('TRADING_PAUSED');

    await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'test cleanup', actor: 'test' });
  });
});
