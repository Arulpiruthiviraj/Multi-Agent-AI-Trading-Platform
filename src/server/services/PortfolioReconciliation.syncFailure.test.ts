import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * Real gap found and fixed (2026-09-15, post-forensic-audit remediation). Before this fix,
 * broker.portfolio() throwing (network error, auth failure, broker outage) inside reconcile()
 * was logged and swallowed - BrokerManager's syncState unconditionally returned to READY in
 * reconcile()'s finally block, so the next attempt was an ordinary, un-escalated blind retry on
 * the next scheduled tick. This directly contradicted the documented invariant "UNKNOWN broker
 * state -> PAUSE + RECONCILE, never blind retry" - only a CONFIRMED, MEASURED position mismatch
 * actually paused trading; an inability to even ask the broker for its positions did not.
 *
 *   BROKER SYNC FAILS REPEATEDLY -> RECONCILIATION ESCALATES -> TRADING PAUSED -> RISK ENGINE
 *   REJECTS NEW ORDERS AT emergency_stop
 *
 * Mirrors PortfolioReconciliation.tradingBlock.test.ts's real end-to-end pattern (real isolated
 * temp DB, real BrokerManager/RiskEngine, no module mocked except the one broker method under
 * test) - proves the fix reaches an actual RiskEngine rejection, not merely a changed flag.
 */
describe('Portfolio reconciliation sync failure (broker unreachable) escalates to a real trading pause', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let riskEngine: any;
  let tradingEngine: any;
  let portfolioReconciliationWorker: any;
  let eventBus: any;
  let EVENTS: any;
  let brokerManager: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_reconcile_syncfail_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ riskEngine } = await import('../engines/RiskEngine'));
    ({ tradingEngine } = await import('../engines/TradingEngine'));
    ({ portfolioReconciliationWorker } = await import('./PortfolioReconciliation'));
    ({ eventBus } = await import('../core/EventBus'));
    ({ EVENTS } = await import('../core/eventNames'));
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    brokerManager = BrokerManager.getInstance();

    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    const { marketDataWorker } = await import('./MarketDataWorker');
    marketDataWorker.cacheObservedQuote('AAPL', 150);

    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;

    await db.insert(schema.settings).values({ maxTradeSize: 5000, riskLevel: 'Balanced', maxOpenPositions: 10 });
  });

  beforeEach(async () => {
    brokerManager.resetSyncStateForTests('READY');
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    portfolioReconciliationWorker.resetFaultDebounceForTests();
    await db.delete(schema.portfolio);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('a single transient broker.portfolio() failure does NOT pause trading (no blind-pause on a one-off blip)', async () => {
    const broker = brokerManager.getActiveBroker();
    const spy = vi.spyOn(broker, 'portfolio').mockRejectedValueOnce(new Error('simulated transient network error'));
    try {
      await portfolioReconciliationWorker.reconcile();
      expect(tradingEngine.state.tradingState).toBe('TRADING_ENABLED');

      const events = await db.select().from(schema.reconciliationEvents);
      const last = events[events.length - 1];
      expect(last.actionTaken).toBe('SYNC_FAILURE_DEFERRED');
    } finally {
      spy.mockRestore();
    }
  });

  it('repeated (consecutive) broker.portfolio() failures escalate to a real TRADING_PAUSED, verified to actually block new orders at RiskEngine emergency_stop', async () => {
    const broker = brokerManager.getActiveBroker();
    const spy = vi.spyOn(broker, 'portfolio').mockRejectedValue(new Error('simulated persistent broker outage'));
    const received: any[] = [];
    const listener = (payload: any) => received.push(payload);
    eventBus.subscribe(EVENTS.RECONCILIATION_SYNC_FAILED, listener);

    try {
      // First cycle: deferred (matches FD-7's own "never pause on a one-off" philosophy).
      await portfolioReconciliationWorker.reconcile();
      expect(tradingEngine.state.tradingState).toBe('TRADING_ENABLED');

      // Second consecutive cycle: escalates (reconPauseConsecutiveMismatchCycles is 2 in this
      // deployment's config, same threshold every other reconciliation fault type already uses).
      await portfolioReconciliationWorker.reconcile();
      expect(tradingEngine.state.tradingState).toBe('TRADING_PAUSED');

      // Real, observable event - not just a swallowed console.error.
      expect(received.length).toBeGreaterThanOrEqual(2);
      const lastEvent = received[received.length - 1];
      expect(lastEvent.tradingPaused).toBe(true);
      expect(lastEvent.consecutiveFailures).toBeGreaterThanOrEqual(2);

      // Real, persisted audit row.
      const events = await db.select().from(schema.reconciliationEvents);
      const lastRow = events[events.length - 1];
      expect(lastRow.actionTaken).toBe('SYNC_FAILURE_TRADING_PAUSED');
      expect(lastRow.matches).toBe(false);

      // Real kill-switch audit row.
      const killSwitchRows = await db.select().from(schema.killSwitchEvents);
      const lastKill = killSwitchRows[killSwitchRows.length - 1];
      expect(lastKill.toState).toBe('TRADING_PAUSED');
      expect(lastKill.actor).toBe('system:PortfolioReconciliation');

      // The actual order-blocking behavior, not just the flag - restore the broker to healthy
      // first, so this specifically proves the PAUSE (not a coincidental broker-still-down error)
      // is what blocks the new order, isolating emergency_stop from any other failure mode.
      spy.mockRestore();
      const blockedTraceId = 'reconcile-syncfail-block';
      await riskEngine.evaluateRisk({ traceId: blockedTraceId, symbol: 'AAPL', side: 'BUY', currentPrice: 150 });
      const [blocked] = await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.traceId, blockedTraceId));
      expect(blocked.approved).toBe(false);
      expect(blocked.rejectionGate).toBe('emergency_stop');
    } finally {
      eventBus.unsubscribe(EVENTS.RECONCILIATION_SYNC_FAILED, listener);
      spy.mockRestore();
      await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'test cleanup', actor: 'test' });
    }
  });

  it('a successful sync after prior failures clears the fault streak (does not carry over into an unrelated future outage)', async () => {
    const broker = brokerManager.getActiveBroker();
    const spy = vi.spyOn(broker, 'portfolio').mockRejectedValueOnce(new Error('simulated one-off error'));
    try {
      await portfolioReconciliationWorker.reconcile(); // 1 failure recorded
      spy.mockRestore();

      await portfolioReconciliationWorker.reconcile(); // real success - should clear the streak
      expect(tradingEngine.state.tradingState).toBe('TRADING_ENABLED');

      // A second, later single failure must be treated as a fresh count of 1, not a continuation -
      // proven by NOT pausing on just this one more failure.
      const spy2 = vi.spyOn(broker, 'portfolio').mockRejectedValueOnce(new Error('simulated later, unrelated error'));
      try {
        await portfolioReconciliationWorker.reconcile();
        expect(tradingEngine.state.tradingState).toBe('TRADING_ENABLED');
      } finally {
        spy2.mockRestore();
      }
    } finally {
      spy.mockRestore();
    }
  });
});
