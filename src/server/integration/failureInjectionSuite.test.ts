import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * ==========================================================
 * Failure-Injection Test Suite
 *
 * Purpose:
 * Consolidates the 6 scenarios identified in ARGUS_FINAL_FORENSIC_AUDIT.md §18/§22 as "individual
 * mechanisms verified, but no single enumerated automated failure-injection suite exists as one
 * artifact." Every mechanism tested here is real, pre-existing production code (RiskEngine,
 * PositionSizing, OrderManagement, LiveTradingConfirmation) - this file does not invent new
 * safety logic, it proves the existing fail-closed behavior end-to-end, together, in one place.
 *
 * Real isolated temp SQLite DB per describe block, matching this codebase's established
 * integration-test pattern throughout the rest of this repository.
 * ==========================================================
 */

describe('Failure Injection Suite', () => {
  // ------------------------------------------------------------------
  // 1. Market hours clock failure (HTTP 500 / network timeout)
  // ------------------------------------------------------------------
  describe('1. Market hours clock failure', () => {
    let tmpDbPath: string;
    let db: any;
    let sqliteDb: any;
    let schema: any;
    let riskEngine: any;
    let resetMarketClockCacheForTests: any;

    beforeAll(async () => {
      tmpDbPath = path.join(os.tmpdir(), `argus_fi_markethours_${Date.now()}_${process.pid}.db`);
      process.env.ARGUS_DB_PATH = tmpDbPath;
      process.env.ALPACA_API_KEY = 'test-key';
      process.env.ALPACA_SECRET_KEY = 'test-secret';
      ({ db, sqliteDb } = await import('../db'));
      schema = await import('../db/schema');
      ({ riskEngine, resetMarketClockCacheForTests } = await import('../engines/RiskEngine'));
      await db.insert(schema.settings).values({});
    });

    afterAll(() => {
      try { sqliteDb.close(); } catch { /* already closed */ }
      for (const suffix of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
      }
      delete process.env.ARGUS_DB_PATH;
      delete process.env.ALPACA_API_KEY;
      delete process.env.ALPACA_SECRET_KEY;
    });

    afterEach(() => vi.unstubAllGlobals());

    it('a real HTTP 500 from the Alpaca clock endpoint fails closed (never treated as open)', async () => {
      resetMarketClockCacheForTests();
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));

      const traceId = `fi-clock-500-${Date.now()}`;
      await riskEngine.evaluateRisk({ traceId, symbol: 'AAPL', side: 'BUY', currentPrice: 100 });

      const [gate] = await db.select().from(schema.riskGateResults)
        .where(eq(schema.riskGateResults.traceId, traceId));
      const marketHoursGate = (await db.select().from(schema.riskGateResults)
        .where(eq(schema.riskGateResults.traceId, traceId))).find((g: any) => g.gateName === 'market_hours');
      expect(marketHoursGate.passed).toBe(false);
      expect(JSON.parse(marketHoursGate.detail).marketClock).toBe('unavailable');

      const [assessment] = await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.traceId, traceId));
      expect(assessment.approved).toBe(false);
    });

    it('a real network throw from the clock fetch also fails closed', async () => {
      resetMarketClockCacheForTests();
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));

      const traceId = `fi-clock-throw-${Date.now()}`;
      await riskEngine.evaluateRisk({ traceId, symbol: 'AAPL', side: 'BUY', currentPrice: 100 });

      const gates = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
      const marketHoursGate = gates.find((g: any) => g.gateName === 'market_hours');
      expect(marketHoursGate.passed).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // 2. Stale / missing market data
  // ------------------------------------------------------------------
  describe('2. Stale market data', () => {
    it('priceAgeMs === null (never-seen symbol) fails closed as UNKNOWN, not fresh', async () => {
      const { evaluateQuoteFreshness } = await import('../core/marketDataQuality');
      const result = evaluateQuoteFreshness({ priceAgeMs: null });
      expect(result.grade).toBe('UNKNOWN');
      expect(result.passed).toBe(false);
    });

    it('priceAgeMs beyond the configured stale threshold fails closed as RED', async () => {
      const { evaluateQuoteFreshness } = await import('../core/marketDataQuality');
      const result = evaluateQuoteFreshness({ priceAgeMs: 10 * 60 * 1000, staleThresholdMs: 5 * 60 * 1000 });
      expect(result.grade).toBe('RED');
      expect(result.passed).toBe(false);
    });

    it('a fresh real tick passes with grade GREEN or YELLOW, never UNKNOWN/RED', async () => {
      const { evaluateQuoteFreshness } = await import('../core/marketDataQuality');
      const result = evaluateQuoteFreshness({ priceAgeMs: 1000, staleThresholdMs: 5 * 60 * 1000 });
      expect(result.passed).toBe(true);
      expect(['GREEN', 'YELLOW']).toContain(result.grade);
    });
  });

  // ------------------------------------------------------------------
  // 3. Account equity disconnect (null / negative / zero)
  // ------------------------------------------------------------------
  describe('3. Invalid account equity', () => {
    let tmpDbPath: string;
    let db: any;
    let sqliteDb: any;
    let schema: any;
    let riskEngine: any;

    beforeAll(async () => {
      tmpDbPath = path.join(os.tmpdir(), `argus_fi_equity_${Date.now()}_${process.pid}.db`);
      process.env.ARGUS_DB_PATH = tmpDbPath;
      delete process.env.ALPACA_API_KEY;
      delete process.env.ALPACA_SECRET_KEY;
      // A prior describe block in this file already imported (and, in its own afterAll, closed)
      // ../db bound to a different temp DB - Node's module cache would otherwise hand this block
      // that same now-closed connection.
      vi.resetModules();
      ({ db, sqliteDb } = await import('../db'));
      schema = await import('../db/schema');
      ({ riskEngine } = await import('../engines/RiskEngine'));
      await db.insert(schema.settings).values({});

      // Force InternalPaperBroker.portfolio() to report a real broken equity value for each case
      // under test - real fail-closed behavior must hold regardless of *why* equity is invalid.
      const { BrokerManager } = await import('../../brokers/BrokerManager');
      await BrokerManager.getInstance().initialize();

      // Isolate the equity gate: Autobot is off and tradingState isn't TRADING_ENABLED by default
      // on a fresh module load, which would fail emergency_stop/autobot_enabled FIRST and mask
      // what this block actually tests. Real bug found and fixed this pass: RiskEngine's
      // invalid-equity branch used to always report INVALID_ACCOUNT_EQUITY regardless of which
      // gate genuinely failed first - these tests only ever isolated the equity gate by accident,
      // because the bug happened to always report equity. Explicit setup here matches the fixed,
      // honest "first gate to fail" behavior.
      const { tradingEngine } = await import('../engines/TradingEngine');
      tradingEngine.state.enabled = true;
      tradingEngine.state.tradingState = 'TRADING_ENABLED';
    });

    afterAll(() => {
      try { sqliteDb.close(); } catch { /* already closed */ }
      for (const suffix of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
      }
      delete process.env.ARGUS_DB_PATH;
    });

    async function testInvalidEquity(equity: unknown) {
      const { BrokerManager } = await import('../../brokers/BrokerManager');
      const broker = BrokerManager.getInstance().getActiveBroker();
      const spy = vi.spyOn(broker, 'portfolio').mockResolvedValue({
        cash: 10000, buyingPower: 10000, equity: equity as number, positions: [],
      } as any);

      const traceId = `fi-equity-${String(equity)}-${Date.now()}`;
      await riskEngine.evaluateRisk({ traceId, symbol: 'AAPL', side: 'BUY', currentPrice: 100 });

      const [assessment] = await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.traceId, traceId));
      expect(assessment.approved).toBe(false);
      expect(assessment.maxQuantity).toBe(0);
      // No placeholder balance - the reasoning must say so honestly, not silently default to $10,000/$100,000.
      expect(assessment.reasoning).toContain('INVALID_ACCOUNT_EQUITY');
      spy.mockRestore();
    }

    it('null equity refuses outright, no placeholder balance', async () => { await testInvalidEquity(null); });
    it('negative equity refuses outright', async () => { await testInvalidEquity(-500); });
    it('zero equity refuses outright', async () => { await testInvalidEquity(0); });
    it('NaN equity refuses outright', async () => { await testInvalidEquity(NaN); });

    it('real bug found and fixed: when an earlier gate (emergency_stop) ALSO fails, the reported reason is the real first failure, not always INVALID_ACCOUNT_EQUITY', async () => {
      const { BrokerManager } = await import('../../brokers/BrokerManager');
      const broker = BrokerManager.getInstance().getActiveBroker();
      const spy = vi.spyOn(broker, 'portfolio').mockResolvedValue({
        cash: 10000, buyingPower: 10000, equity: null as any, positions: [],
      } as any);
      const { tradingEngine } = await import('../engines/TradingEngine');
      const prevState = tradingEngine.state.tradingState;
      tradingEngine.state.tradingState = 'TRADING_PAUSED';
      try {
        const traceId = `fi-equity-and-pause-${Date.now()}`;
        await riskEngine.evaluateRisk({ traceId, symbol: 'AAPL', side: 'BUY', currentPrice: 100 });
        const [assessment] = await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.traceId, traceId));
        expect(assessment.approved).toBe(false);
        // emergency_stop fails first (tradingState !== TRADING_ENABLED) - that must be the
        // reported reason, even though equity is also invalid and gets recorded too.
        expect(assessment.reasoning).toContain('Trading is paused');
        expect(assessment.reasoning).not.toContain('INVALID_ACCOUNT_EQUITY');
        const gates = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
        const equityGate = gates.find((g: any) => g.gateName === 'invalid_account_equity');
        expect(equityGate?.passed).toBe(false); // still recorded, just not the reported reason
      } finally {
        tradingEngine.state.tradingState = prevState;
        spy.mockRestore();
      }
    });
  });

  // ------------------------------------------------------------------
  // 4. Duplicate order concurrency (identical traceId)
  // ------------------------------------------------------------------
  describe('4. Duplicate order concurrency', () => {
    let tmpDbPath: string;
    let db: any;
    let sqliteDb: any;
    let schema: any;
    let oms: any;

    beforeAll(async () => {
      tmpDbPath = path.join(os.tmpdir(), `argus_fi_dup_${Date.now()}_${process.pid}.db`);
      process.env.ARGUS_DB_PATH = tmpDbPath;
      vi.resetModules();
      ({ db, sqliteDb } = await import('../db'));
      schema = await import('../db/schema');
      const mod = await import('../services/OrderManagement');
      oms = mod.oms ?? new mod.OrderManagementService();
    });

    afterAll(() => {
      try { sqliteDb.close(); } catch { /* already closed */ }
      for (const suffix of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
      }
      delete process.env.ARGUS_DB_PATH;
    });

    it('two concurrent executeOrder() calls for the same traceId only ever produce one trades row', async () => {
      const traceId = `fi-dup-${Date.now()}`;
      // Both calls race the same real DB unique index (idx_trades_trace_id_unique); the
      // check-then-act select above it is a known, accepted race - the constraint is the real
      // authoritative guarantee under test here.
      await Promise.allSettled([
        oms.executeOrder('AAPL', 'BUY', 1, 'race A', traceId),
        oms.executeOrder('AAPL', 'BUY', 1, 'race B', traceId),
      ]);

      const rows = await db.select().from(schema.trades).where(eq(schema.trades.traceId, traceId));
      expect(rows.length).toBe(1);
    });
  });

  // ------------------------------------------------------------------
  // 5. Restart while LIVE arm is set (in-memory arm must not survive)
  // ------------------------------------------------------------------
  describe('5. Restart clears the LIVE arm', () => {
    it('a fresh module load (simulating a real process restart) never carries an armed LIVE state forward', async () => {
      vi.resetModules();
      const first = await import('../core/LiveTradingConfirmation');
      expect(first.isLiveTradingArmed()).toBe(false);
      const armed = first.armLiveTrading(first.LIVE_TRADING_CONFIRMATION_PHRASE);
      expect(armed).toBe(true);
      expect(first.isLiveTradingArmed()).toBe(true);

      // A real process restart is a fresh Node process - module-level `let liveOrdersArmed` state
      // is unreachable from a new process by construction. vi.resetModules() + a fresh import is
      // the real, established way this codebase simulates that boundary in a single test process.
      vi.resetModules();
      const afterRestart = await import('../core/LiveTradingConfirmation');
      expect(afterRestart.isLiveTradingArmed()).toBe(false);
      const arm = afterRestart.assertLiveOrdersArmed();
      expect(arm.ok).toBe(false);
      expect(arm.reason).toContain('LIVE_ARM_REQUIRED');
    });

    it('an unconfirmed or wrong phrase never arms LIVE', async () => {
      vi.resetModules();
      const mod = await import('../core/LiveTradingConfirmation');
      expect(mod.armLiveTrading('close enough')).toBe(false);
      expect(mod.armLiveTrading(undefined)).toBe(false);
      expect(mod.armLiveTrading(null)).toBe(false);
      expect(mod.isLiveTradingArmed()).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // 6. Broker network timeout during order submission
  // ------------------------------------------------------------------
  describe('6. Broker network timeout during submit', () => {
    let tmpDbPath: string;
    let db: any;
    let sqliteDb: any;
    let schema: any;
    let oms: any;

    beforeAll(async () => {
      tmpDbPath = path.join(os.tmpdir(), `argus_fi_timeout_${Date.now()}_${process.pid}.db`);
      process.env.ARGUS_DB_PATH = tmpDbPath;
      vi.resetModules();
      ({ db, sqliteDb } = await import('../db'));
      schema = await import('../db/schema');
      const mod = await import('../services/OrderManagement');
      oms = mod.oms ?? new mod.OrderManagementService();
      await db.insert(schema.settings).values({});
    });

    afterAll(() => {
      try { sqliteDb.close(); } catch { /* already closed */ }
      for (const suffix of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
      }
      delete process.env.ARGUS_DB_PATH;
    });

    it('a real broker.placeOrder() throw leaves the order PENDING (submitOutcome=UNKNOWN), never a fabricated FILLED or REJECTED', async () => {
      const { BrokerManager } = await import('../../brokers/BrokerManager');
      await BrokerManager.getInstance().initialize();
      const broker = BrokerManager.getInstance().getActiveBroker();
      const spy = vi.spyOn(broker, 'placeOrder').mockRejectedValue(new Error('ETIMEDOUT'));

      const traceId = `fi-timeout-${Date.now()}`;
      await oms.executeOrder('AAPL', 'BUY', 1, 'timeout test', traceId);

      const [row] = await db.select().from(schema.trades).where(eq(schema.trades.traceId, traceId));
      expect(row.status).toBe('PENDING');
      expect(row.brokerOrderId).toBeNull();
      expect(row.reasoning).toContain('submitOutcome=UNKNOWN');

      spy.mockRestore();
      // Real environmental cause found and accommodated (2026-08-27): BrokerManager.initialize()
      // unconditionally calls .initialize() on every registered adapter, including AlpacaBroker -
      // once real Alpaca credentials are present in .env (as they now are in this environment),
      // that becomes a real, bounded network validation call rather than a fast no-op, and can
      // exceed vitest's 5000ms default. This test's own assertions are unaffected by that call's
      // outcome (only the mocked placeOrder() throw matters); it needs more wall-clock room, not
      // different behavior.
    }, 20000);
  });
});
