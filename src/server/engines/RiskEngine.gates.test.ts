import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';
import { getTradingDateStr } from '../core/TradingCalendar';

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
});
