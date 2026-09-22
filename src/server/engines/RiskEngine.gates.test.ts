import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';
import { getTradingDateStr } from '../core/TradingCalendar';
import { seedRuntimeOverrideCacheForTests, resetRuntimeConfigCacheForTests } from '../config/effectiveRuntimeConfig';

/**
 * Real integration test (isolated temp SQLite DB, no per-module mocks) proving the actual point
 * of the Phase 2 refactor: RiskEngine now evaluates every gate even after an earlier one has
 * already failed, instead of early-exiting. Uses the real BrokerManager singleton, which
 * defaults to InternalPaperBroker (no external credentials needed).
 */
describe('RiskEngine gate accumulation (Phase 2)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let riskEngine: any;
  let tradingEngine: any;
  const gateEvents: any[] = [];

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_riskgates_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    const { eventBus } = await import('../core/EventBus');
    eventBus.on('RISK_GATE_EVALUATED', (e: any) => gateEvents.push(e));
    ({ riskEngine } = await import('./RiskEngine'));
    ({ tradingEngine } = await import('./TradingEngine'));
    const { marketDataWorker } = await import('../services/MarketDataWorker');
    marketDataWorker.cacheObservedQuote('AAPL', 150);
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';

    // Deleting these BEFORE the imports above doesn't stick: EncryptionService.ts calls
    // dotenv.config() as a module-load side effect, and default dotenv behavior re-populates any
    // key that looks "unset" - which `delete` produces - from .env. That silently undid this
    // simulated "no Alpaca credentials" state after the import chain ran, making isMarketOpen()
    // hit the real Alpaca clock API instead of short-circuiting - a real, previously-undetected
    // test-reliability bug that only surfaced as a failure when the real market happened to be
    // closed at the moment the suite ran. Deleting here, after all imports have already triggered
    // any dotenv reload, is what actually makes it stick for the rest of this file's tests.
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('still evaluates and records every downstream gate after the daily-loss circuit breaker rejects', async () => {
    // Force the daily-loss kill-switch to trip immediately, regardless of the paper broker's
    // real (essentially flat) equity - this only needs the FIRST gate to fail; every gate after
    // it should still run and be recorded.
    tradingEngine.state.dayStartDateStr = getTradingDateStr();
    tradingEngine.state.dayStartEquity = 1_000_000;
    tradingEngine.state.dailyLossLimit = 1; // trivially breached - the paper broker's equity will be far below 999,999.2

    const traceId = 'gates-test-1';
    await riskEngine.evaluateRisk({ traceId, symbol: 'AAPL', side: 'BUY', currentPrice: 150 });

    const [assessment] = await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.traceId, traceId));
    expect(assessment.approved).toBe(false);
    expect(assessment.rejectionGate).toBe('daily_loss');

    const gates = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
    const gateNames = gates.map((g: any) => g.gateName);

    // The real proof: gates that come AFTER daily_loss in evaluation order were still run and
    // recorded, not skipped just because the first gate already failed.
    expect(gateNames).toContain('daily_loss');
    expect(gateNames).toContain('consecutive_loss');
    expect(gateNames).toContain('market_hours');
    expect(gateNames).toContain('data_freshness');
    expect(gateNames).toContain('news_veto');
    expect(gateNames).toContain('price_validity');
    expect(gateNames).toContain('sufficient_size');

    const dailyLossGate = gates.find((g: any) => g.gateName === 'daily_loss');
    expect(dailyLossGate.passed).toBe(false);
    // A gate downstream of the failure should still show a real (not fabricated) evaluated
    // result - price_validity has nothing to do with daily loss, so it should have passed.
    const priceGate = gates.find((g: any) => g.gateName === 'price_validity');
    expect(priceGate.passed).toBe(true);

    // Live RISK_GATE_EVALUATED events fired for this trace, matching the persisted rows.
    const eventsForTrace = gateEvents.filter(e => e.traceId === traceId);
    expect(eventsForTrace.length).toBe(gates.length);
  });

  it('blocks and records rejection via the emergency_stop gate - previously bypassed RiskEngine entirely via a RiskAgent pre-check', async () => {
    tradingEngine.state.dayStartDateStr = getTradingDateStr();
    tradingEngine.state.dayStartEquity = 100000;
    tradingEngine.state.dailyLossLimit = 5000;
    tradingEngine.state.emergencyStopActive = true;
    tradingEngine.state.tradingState = 'EMERGENCY_STOP';

    const traceId = 'gates-test-emergency';
    try {
      await riskEngine.evaluateRisk({ traceId, symbol: 'AAPL', side: 'BUY', currentPrice: 150 });

      const [assessment] = await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.traceId, traceId));
      expect(assessment.approved).toBe(false);
      expect(assessment.rejectionGate).toBe('emergency_stop');

      const gates = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
      const emergencyGate = gates.find((g: any) => g.gateName === 'emergency_stop');
      expect(emergencyGate.passed).toBe(false);
      // Every downstream gate was still evaluated and recorded - not bypassed.
      expect(gates.map((g: any) => g.gateName)).toContain('sufficient_size');
    } finally {
      tradingEngine.state.emergencyStopActive = false;
      tradingEngine.state.tradingState = 'TRADING_ENABLED';
    }
  });

  it('persists a full passing gate ladder for an approved trade', async () => {
    tradingEngine.state.dayStartDateStr = getTradingDateStr();
    tradingEngine.state.dayStartEquity = 100000;
    tradingEngine.state.dailyLossLimit = 5000;

    const traceId = 'gates-test-2';
    await riskEngine.evaluateRisk({ traceId, symbol: 'AAPL', side: 'BUY', currentPrice: 150 });

    const [assessment] = await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.traceId, traceId));
    expect(assessment.approved).toBe(true);
    expect(assessment.rejectionGate).toBeNull();

    const gates = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
    expect(gates.every((g: any) => g.passed)).toBe(true);
    expect(gates.map((g: any) => g.gateName)).toContain('symbol_concentration');
  });

  // 2026-09-21 forensic audit regression: risk_assessments has no executionEnvironment column, and
  // RiskEngine's own reasoning text previously never carried an executionEnvironment= stamp the
  // way OMS's trades.reasoning already does - so every real risk_assessments row fell through
  // organicPaper.ts's classifyTradeEnvironment() to UNKNOWN, undercounting real risk evaluations
  // in tradingSessionReport.ts even though RiskEngine had genuinely evaluated the trade.
  it('stamps the persisted risk_assessments.reasoning with executionEnvironment so it classifies correctly (not UNKNOWN)', async () => {
    tradingEngine.state.dayStartDateStr = getTradingDateStr();
    tradingEngine.state.dayStartEquity = 100000;
    tradingEngine.state.dailyLossLimit = 5000;

    const traceId = 'gates-test-env-stamp';
    await riskEngine.evaluateRisk({ traceId, symbol: 'AAPL', side: 'BUY', currentPrice: 150 });

    const [assessment] = await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.traceId, traceId));
    expect(assessment.reasoning).toMatch(/executionEnvironment=PAPER/);

    const { classifyTradeEnvironment } = await import('../research/organicPaper');
    expect(classifyTradeEnvironment({ traceId: assessment.traceId, reasoning: assessment.reasoning })).toBe('PAPER');
  });

  it('records autobot_enabled fail on BUY when Autobot is off', async () => {
    tradingEngine.state.enabled = false;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    tradingEngine.state.dayStartDateStr = getTradingDateStr();
    tradingEngine.state.dayStartEquity = 100000;
    tradingEngine.state.dailyLossLimit = 5000;
    const traceId = 'gates-test-autobot';
    try {
      await riskEngine.evaluateRisk({ traceId, symbol: 'AAPL', side: 'BUY', currentPrice: 150 });
      const [assessment] = await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.traceId, traceId));
      expect(assessment.approved).toBe(false);
      expect(assessment.rejectionGate).toBe('autobot_enabled');
    } finally {
      tradingEngine.state.enabled = true;
    }
  });

  // Crypto Expansion Phase 1 (2026-09-21): gate 15 (price_validity) proof that equity behavior is
  // unchanged and registered crypto instruments now pass while unregistered crypto-shaped symbols
  // still fail closed exactly as before. See core/InstrumentRegistry.ts.
  describe('price_validity gate (gate 15) - Crypto Expansion Phase 1', () => {
    beforeAll(() => {
      tradingEngine.state.enabled = true;
      tradingEngine.state.tradingState = 'TRADING_ENABLED';
      // CRYPTO is disabled by default (ARGUS_TRADEABLE_ASSET_CLASSES defaults to EQUITY-only) -
      // explicitly opt it in, since this block specifically tests the crypto validation path.
      seedRuntimeOverrideCacheForTests('ARGUS_TRADEABLE_ASSET_CLASSES', 'EQUITY,CRYPTO');
    });
    afterAll(() => resetRuntimeConfigCacheForTests());

    it('equity behavior unchanged: AAPL still passes price_validity', async () => {
      tradingEngine.state.dayStartDateStr = getTradingDateStr();
      tradingEngine.state.dayStartEquity = 100000;
      tradingEngine.state.dailyLossLimit = 5000;
      const traceId = 'gates-test-crypto-equity-unchanged';
      await riskEngine.evaluateRisk({ traceId, symbol: 'AAPL', side: 'BUY', currentPrice: 150 });
      const gates = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
      const gate = gates.find((g: any) => g.gateName === 'price_validity');
      expect(gate.passed).toBe(true);
      expect(JSON.parse(gate.detail).reasonCode).toBe('OK');
      expect(JSON.parse(gate.detail).assetClass).toBe('EQUITY');
    });

    it('registered crypto instrument (BTC-USD) with a valid price passes price_validity', async () => {
      tradingEngine.state.dayStartDateStr = getTradingDateStr();
      tradingEngine.state.dayStartEquity = 100000;
      tradingEngine.state.dailyLossLimit = 5000;
      const traceId = 'gates-test-crypto-btc-valid';
      await riskEngine.evaluateRisk({ traceId, symbol: 'BTC-USD', side: 'BUY', currentPrice: 60000 });
      const gates = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
      const gate = gates.find((g: any) => g.gateName === 'price_validity');
      expect(gate.passed).toBe(true);
      expect(JSON.parse(gate.detail).assetClass).toBe('CRYPTO');
    });

    it('registered crypto instrument (ETH-USD) with a valid price passes price_validity', async () => {
      tradingEngine.state.dayStartDateStr = getTradingDateStr();
      tradingEngine.state.dayStartEquity = 100000;
      tradingEngine.state.dailyLossLimit = 5000;
      const traceId = 'gates-test-crypto-eth-valid';
      await riskEngine.evaluateRisk({ traceId, symbol: 'ETH-USD', side: 'BUY', currentPrice: 2500 });
      const gates = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
      const gate = gates.find((g: any) => g.gateName === 'price_validity');
      expect(gate.passed).toBe(true);
      expect(JSON.parse(gate.detail).assetClass).toBe('CRYPTO');
    });

    it('unregistered crypto-shaped symbol (DOG-FAKE) still fails price_validity - a hyphen alone never passes', async () => {
      tradingEngine.state.dayStartDateStr = getTradingDateStr();
      tradingEngine.state.dayStartEquity = 100000;
      tradingEngine.state.dailyLossLimit = 5000;
      const traceId = 'gates-test-crypto-unregistered';
      await riskEngine.evaluateRisk({ traceId, symbol: 'DOG-FAKE', side: 'BUY', currentPrice: 1 });
      const gates = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
      const gate = gates.find((g: any) => g.gateName === 'price_validity');
      expect(gate.passed).toBe(false);
      expect(JSON.parse(gate.detail).reasonCode).toBe('INVALID_SYMBOL');
      // Not asserting assessment.rejectionGate here: by this point in the file enough
      // evaluateRisk() calls have run within the 60s order_rate_limit window that an earlier
      // gate (order_rate_limit, #11) can legitimately win the "first failure in evaluation
      // order" slot - price_validity (#15) is still independently evaluated and failed above,
      // which is the actual behavior this test proves.
    });

    it('provider-notation crypto symbol (BTC/USD) fails price_validity - canonical symbols only', async () => {
      tradingEngine.state.dayStartDateStr = getTradingDateStr();
      tradingEngine.state.dayStartEquity = 100000;
      tradingEngine.state.dailyLossLimit = 5000;
      const traceId = 'gates-test-crypto-provider-notation';
      await riskEngine.evaluateRisk({ traceId, symbol: 'BTC/USD', side: 'BUY', currentPrice: 60000 });
      const gates = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
      const gate = gates.find((g: any) => g.gateName === 'price_validity');
      expect(gate.passed).toBe(false);
      expect(JSON.parse(gate.detail).reasonCode).toBe('INVALID_SYMBOL');
    });

    it('registered crypto instrument with a missing/invalid price still fails price_validity (crypto is not a bypass of price checks)', async () => {
      tradingEngine.state.dayStartDateStr = getTradingDateStr();
      tradingEngine.state.dayStartEquity = 100000;
      tradingEngine.state.dailyLossLimit = 5000;
      const traceId = 'gates-test-crypto-btc-no-price';
      await riskEngine.evaluateRisk({ traceId, symbol: 'BTC-USD', side: 'BUY', currentPrice: null });
      const gates = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
      const gate = gates.find((g: any) => g.gateName === 'price_validity');
      expect(gate.passed).toBe(false);
      expect(JSON.parse(gate.detail).reasonCode).toBe('MISSING_PRICE');
    });
  });

  // Crypto Expansion Phase 4 (2026-09-21): proves the real, previously-unverified end-to-end claim
  // that gate 13 (data_freshness) needed ZERO code changes for crypto - it already reads generically
  // from MarketDataWorker's observed-quote cache via getLatestPriceAgeMs(), which round-trips
  // "BTC-USD" exactly like "AAPL" (quoteKey() has no equity-only regex). This is what
  // CryptoMarketDataIngestion.ts's real ingestion writes into.
  it('data_freshness gate (gate 13) passes for a registered crypto instrument once a quote is cached - no RiskEngine code change was needed for this gate', async () => {
    tradingEngine.state.dayStartDateStr = getTradingDateStr();
    tradingEngine.state.dayStartEquity = 100000;
    tradingEngine.state.dailyLossLimit = 5000;
    const { marketDataWorker } = await import('../services/MarketDataWorker');
    marketDataWorker.cacheObservedQuote('BTC-USD', 60000);
    const traceId = 'gates-test-crypto-data-freshness-btc';
    await riskEngine.evaluateRisk({ traceId, symbol: 'BTC-USD', side: 'BUY', currentPrice: 60000 });
    const gates = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
    const gate = gates.find((g: any) => g.gateName === 'data_freshness');
    expect(gate.passed).toBe(true);
  });

  // Crypto Expansion Phase 3 (2026-09-21): gate 12 (market_hours) no longer applies the equity
  // Alpaca-clock concept to a registered crypto instrument - real infrastructure readiness gates
  // it instead. No CryptoPaperBroker exists yet (Phase 13), so every crypto proposal correctly
  // fails this gate today with PAPER_BROKER_UNAVAILABLE once the earlier checks pass - this is the
  // honest current state, not a bug.
  describe('market_hours gate (gate 12) - Crypto Expansion Phase 3', () => {
    beforeAll(() => {
      tradingEngine.state.enabled = true;
      tradingEngine.state.tradingState = 'TRADING_ENABLED';
      seedRuntimeOverrideCacheForTests('ARGUS_TRADEABLE_ASSET_CLASSES', 'EQUITY,CRYPTO');
    });
    afterAll(() => resetRuntimeConfigCacheForTests());

    it('equity behavior unchanged: market_hours gate detail has no assetClass field for AAPL', async () => {
      tradingEngine.state.dayStartDateStr = getTradingDateStr();
      tradingEngine.state.dayStartEquity = 100000;
      tradingEngine.state.dailyLossLimit = 5000;
      const traceId = 'gates-test-crypto-market-hours-equity';
      await riskEngine.evaluateRisk({ traceId, symbol: 'AAPL', side: 'BUY', currentPrice: 150 });
      const gates = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
      const gate = gates.find((g: any) => g.gateName === 'market_hours');
      expect(JSON.parse(gate.detail).assetClass).toBeUndefined();
    });

    it('a registered crypto instrument with fresh data still fails market_hours - PAPER_BROKER_UNAVAILABLE (no broker exists yet, honestly reported)', async () => {
      tradingEngine.state.dayStartDateStr = getTradingDateStr();
      tradingEngine.state.dayStartEquity = 100000;
      tradingEngine.state.dailyLossLimit = 5000;
      const { marketDataWorker } = await import('../services/MarketDataWorker');
      marketDataWorker.cacheObservedQuote('BTC-USD', 60000);
      const traceId = 'gates-test-crypto-market-hours-btc';
      await riskEngine.evaluateRisk({ traceId, symbol: 'BTC-USD', side: 'BUY', currentPrice: 60000 });
      const gates = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
      const gate = gates.find((g: any) => g.gateName === 'market_hours');
      expect(gate.passed).toBe(false);
      const detail = JSON.parse(gate.detail);
      expect(detail.assetClass).toBe('CRYPTO');
      expect(detail.reasonCode).toBe('PAPER_BROKER_UNAVAILABLE');
      expect(detail.instrumentEnabled).toBe(true);
      expect(detail.dataSourceAvailable).toBe(true);
    });

    it('a registered crypto instrument with no cached quote fails market_hours with DATA_SOURCE_UNAVAILABLE, not PAPER_BROKER_UNAVAILABLE', async () => {
      tradingEngine.state.dayStartDateStr = getTradingDateStr();
      tradingEngine.state.dayStartEquity = 100000;
      tradingEngine.state.dailyLossLimit = 5000;
      const traceId = 'gates-test-crypto-market-hours-eth-nodata';
      await riskEngine.evaluateRisk({ traceId, symbol: 'ETH-USD', side: 'BUY', currentPrice: 2500 });
      const gates = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
      const gate = gates.find((g: any) => g.gateName === 'market_hours');
      expect(gate.passed).toBe(false);
      const detail = JSON.parse(gate.detail);
      expect(detail.reasonCode).toBe('DATA_SOURCE_UNAVAILABLE');
      expect(detail.dataSourceAvailable).toBe(false);
    });

    it('does not silently pass for crypto merely because Alpaca market_hours would otherwise be unconfigured/open', async () => {
      // Regression guard for the mandate's explicit "do not silently PASS if infrastructure is
      // unavailable" requirement - this is the same evaluateRisk() call, same unconfigured Alpaca
      // clock state that lets AAPL pass gate 12 in every other test in this file, yet a crypto
      // proposal must still fail it via the crypto-specific check.
      tradingEngine.state.dayStartDateStr = getTradingDateStr();
      tradingEngine.state.dayStartEquity = 100000;
      tradingEngine.state.dailyLossLimit = 5000;
      const { marketDataWorker } = await import('../services/MarketDataWorker');
      marketDataWorker.cacheObservedQuote('BTC-USD', 60000);
      const traceId = 'gates-test-crypto-market-hours-not-silent';
      await riskEngine.evaluateRisk({ traceId, symbol: 'BTC-USD', side: 'BUY', currentPrice: 60000 });
      const [assessment] = await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.traceId, traceId));
      expect(assessment.approved).toBe(false);
    });
  });
});
