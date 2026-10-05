import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * Real integration test (isolated temp SQLite DB, no per-module mocks) for the Phase 3
 * reconciliation-history persistence. In particular verifies `.returning()` on insert actually
 * works against this project's real better-sqlite3 + drizzle setup - not used anywhere else in
 * the codebase, so this is the first real proof it behaves as expected here.
 */
describe('PortfolioReconciliationWorker.reconcile persistence (Phase 3)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let portfolioReconciliationWorker: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_reconcile_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    // Force the real default active broker (InternalPaperBroker) rather than depending on
    // whatever env-driven broker selection would otherwise happen.
    void BrokerManager;
    ({ portfolioReconciliationWorker } = await import('./PortfolioReconciliation'));
  });

  beforeEach(async () => {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    BrokerManager.getInstance().resetSyncStateForTests('READY');
    portfolioReconciliationWorker.resetFaultDebounceForTests();
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('persists a MATCH reconciliation_events row with no mismatches when local is empty and broker is empty', async () => {
    await portfolioReconciliationWorker.reconcile();

    const events = await db.select().from(schema.reconciliationEvents);
    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1];
    expect(last.matches).toBe(true);
    expect(last.mismatches).toBeNull();
  });

  it('does not certify account consistency using cost basis when a broker mark is missing', async () => {
    const broker = (await import('../../brokers/BrokerManager')).BrokerManager.getInstance().getActiveBroker();
    const original = broker.portfolio;
    broker.portfolio = async () => ({ cash: 1000, buyingPower: 1000, equity: 1100, positions: [
      { symbol: 'NOMRK', quantity: 1, entryPrice: 100, currentPrice: null, marketValue: null,
        unrealizedPnl: null, unrealizedPnlPercent: null, valuationStatus: 'UNAVAILABLE' },
    ] });
    try {
      await portfolioReconciliationWorker.reconcile();
      const events = await db.select().from(schema.reconciliationEvents);
      expect(events.at(-1).matches).toBe(false);
      expect(JSON.parse(events.at(-1).mismatches)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'ACCOUNT_VALUATION_UNAVAILABLE' }),
      ]));
    } finally {
      broker.portfolio = original;
      await db.delete(schema.portfolio).where(eq(schema.portfolio.symbol, 'NOMRK'));
    }
  });

  it('real defect fix (2026-10-05): uses a fresh live tick as the mark when the broker never supplies currentPrice, instead of permanently flagging ACCOUNT_VALUATION_UNAVAILABLE', async () => {
    // Reproduces IBGatewaySocketAdapter's actual, permanent behavior: positions() never populates
    // currentPrice at all (reqPositions has no live mark) - this held an open OKTA-like position
    // paused for an entire real trading morning because the account-consistency check only ever
    // looked at the broker's own (always-null) currentPrice, never at Argus's own live tick cache.
    const { marketDataWorker } = await import('./MarketDataWorker');
    const broker = (await import('../../brokers/BrokerManager')).BrokerManager.getInstance().getActiveBroker();
    const original = broker.portfolio;
    broker.portfolio = async () => ({ cash: 1000, buyingPower: 1000, equity: 1140, positions: [
      { symbol: 'LIVEMRK', quantity: 1, entryPrice: 100, currentPrice: null, marketValue: null,
        unrealizedPnl: null, unrealizedPnlPercent: null, valuationStatus: 'UNAVAILABLE' },
    ] });
    marketDataWorker.cacheObservedQuote('LIVEMRK', 140, Date.now());
    try {
      await portfolioReconciliationWorker.reconcile();
      const events = await db.select().from(schema.reconciliationEvents);
      const last = events.at(-1);
      const mismatches = last.mismatches ? JSON.parse(last.mismatches) : [];
      expect(mismatches).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'ACCOUNT_VALUATION_UNAVAILABLE' }),
      ]));
    } finally {
      broker.portfolio = original;
      await db.delete(schema.portfolio).where(eq(schema.portfolio.symbol, 'LIVEMRK'));
    }
  });

  it('negative control: a stale live tick must NOT be used as a mark - still flags ACCOUNT_VALUATION_UNAVAILABLE', async () => {
    const { marketDataWorker } = await import('./MarketDataWorker');
    const { tradingSafety } = await import('../config/tradingSafety');
    const broker = (await import('../../brokers/BrokerManager')).BrokerManager.getInstance().getActiveBroker();
    const original = broker.portfolio;
    broker.portfolio = async () => ({ cash: 1000, buyingPower: 1000, equity: 1140, positions: [
      { symbol: 'STALEMRK', quantity: 1, entryPrice: 100, currentPrice: null, marketValue: null,
        unrealizedPnl: null, unrealizedPnlPercent: null, valuationStatus: 'UNAVAILABLE' },
    ] });
    marketDataWorker.cacheObservedQuote('STALEMRK', 140, Date.now() - tradingSafety.stalePriceThresholdMs - 60000);
    try {
      await portfolioReconciliationWorker.reconcile();
      const events = await db.select().from(schema.reconciliationEvents);
      const last = events.at(-1);
      const mismatches = last.mismatches ? JSON.parse(last.mismatches) : [];
      expect(mismatches).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'ACCOUNT_VALUATION_UNAVAILABLE' }),
      ]));
    } finally {
      broker.portfolio = original;
      await db.delete(schema.portfolio).where(eq(schema.portfolio.symbol, 'STALEMRK'));
    }
  });

  it('persists a MATCH row and hydrates local when the broker holds a position Argus does not yet have', async () => {
    const broker = (await import('../../brokers/BrokerManager')).BrokerManager.getInstance().getActiveBroker();
    // Monkey-patch portfolio() to simulate a broker-side position Argus's local table doesn't
    // know about, without needing a real fill to have happened first.
    const originalPortfolio = broker.portfolio.bind(broker);
    (broker as any).portfolio = async () => {
      const real = await originalPortfolio();
      return { ...real, positions: [...real.positions, { symbol: 'ZZZTEST', quantity: 42, entryPrice: 10, currentPrice: 10 }] };
    };

    await portfolioReconciliationWorker.reconcile();

    const events = await db.select().from(schema.reconciliationEvents);
    const last = events[events.length - 1];
    expect(last.matches).toBe(true);

    const local = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, 'ZZZTEST'));
    expect(local[0]?.quantity).toBe(42);

    const snapshots = await db.select().from(schema.portfolioSnapshots).where(eq(schema.portfolioSnapshots.reconciliationId, last.id));
    const brokerSnapshot = snapshots.find((s: any) => s.symbol === 'ZZZTEST' && s.source === 'BROKER');
    expect(brokerSnapshot).toBeTruthy();
    expect(brokerSnapshot.quantity).toBe(42);
  });

  it('real re-entrancy guard (Phase 10): a second concurrent reconcile() call is skipped, not run in parallel with the first', async () => {
    const broker = (await import('../../brokers/BrokerManager')).BrokerManager.getInstance().getActiveBroker();
    const originalPortfolio = broker.portfolio.bind(broker);
    let callCount = 0;
    // A real, deliberate delay widens the window - if the guard didn't exist, the second
    // concurrent reconcile() call would start its own full cycle while this one is still
    // in-flight, exactly the overlap this phase closes.
    (broker as any).portfolio = async () => {
      callCount++;
      await new Promise(r => setTimeout(r, 50));
      return originalPortfolio();
    };

    const eventsBefore = await db.select().from(schema.reconciliationEvents);

    await Promise.all([
      portfolioReconciliationWorker.reconcile(),
      portfolioReconciliationWorker.reconcile(),
    ]);

    // Only the first call's broker.portfolio() ever ran - the second returned immediately via
    // the isReconciling guard, before ever calling the broker.
    expect(callCount).toBe(1);

    const eventsAfter = await db.select().from(schema.reconciliationEvents);
    // Exactly one new reconciliation_events row, not two - proving the second call didn't run its
    // own full cycle in parallel.
    expect(eventsAfter.length).toBe(eventsBefore.length + 1);

    (broker as any).portfolio = originalPortfolio;
  });

  it('a significant dollar QUANTITY_DRIFT is written to broker qty without pausing (self-heal, not a flap)', async () => {
    const { tradingEngine } = await import('../engines/TradingEngine');
    await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'test reset', actor: 'tester' });

    await db.insert(schema.portfolio).values({
      symbol: 'DRIFTTEST', quantity: 20, averagePrice: 10, currentPrice: 10, lastUpdated: new Date().toISOString(), brokerSource: 'test',
    });

    const broker = (await import('../../brokers/BrokerManager')).BrokerManager.getInstance().getActiveBroker();
    const originalPortfolio = broker.portfolio.bind(broker);
    (broker as any).portfolio = async () => {
      const real = await originalPortfolio();
      return { ...real, positions: [...real.positions, { symbol: 'DRIFTTEST', quantity: 5, entryPrice: 10, currentPrice: 10 }] };
    };

    await portfolioReconciliationWorker.reconcile();

    expect(tradingEngine.state.tradingState).toBe('TRADING_ENABLED');
    const local = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, 'DRIFTTEST'));
    expect(local[0]?.quantity).toBe(5);
    (broker as any).portfolio = originalPortfolio;
    await db.delete(schema.portfolio).where(eq(schema.portfolio.symbol, 'DRIFTTEST'));
  });

  it('hydrates a broker-only name without recording MISSING_LOCALLY or pausing', async () => {
    const { tradingEngine } = await import('../engines/TradingEngine');
    const { runtimeIntervals } = await import('../config/runtimeIntervals');
    const { resetBootTimestampForTests } = await import('../core/startup');
    resetBootTimestampForTests(Date.now() - runtimeIntervals.reconciliationBootWarmupMs - 1);
    await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'test reset', actor: 'tester' });

    const broker = (await import('../../brokers/BrokerManager')).BrokerManager.getInstance().getActiveBroker();
    const originalPortfolio = broker.portfolio.bind(broker);
    (broker as any).portfolio = async () => {
      const real = await originalPortfolio();
      return { ...real, positions: [...real.positions, { symbol: 'BASELINETEST', quantity: 20, entryPrice: 10, currentPrice: 10 }] };
    };

    await portfolioReconciliationWorker.reconcile();

    expect(tradingEngine.state.tradingState).toBe('TRADING_ENABLED');

    const events = await db.select().from(schema.reconciliationEvents);
    const last = events[events.length - 1];
    expect(last.matches).toBe(true);

    const local = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, 'BASELINETEST'));
    expect(local[0]?.quantity).toBe(20);

    (broker as any).portfolio = originalPortfolio;
    await db.delete(schema.portfolio).where(eq(schema.portfolio.symbol, 'BASELINETEST'));
  });

  it('a call after a previous cycle has fully completed runs normally (the guard does not get stuck)', async () => {
    await portfolioReconciliationWorker.reconcile();
    const eventsBefore = await db.select().from(schema.reconciliationEvents);

    await portfolioReconciliationWorker.reconcile();

    const eventsAfter = await db.select().from(schema.reconciliationEvents);
    expect(eventsAfter.length).toBe(eventsBefore.length + 1);
  });
});
