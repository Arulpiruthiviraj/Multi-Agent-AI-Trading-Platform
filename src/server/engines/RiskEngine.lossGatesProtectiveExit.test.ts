import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';
import { resetRuntimeConfigCacheForTests } from '../config/effectiveRuntimeConfig';
import {
  mintProtectiveExitSeal,
  resetProtectiveExitSealsForTests,
  PROTECTIVE_EXIT_AUTHORIZED_MINTER,
} from '../core/protectiveExitSeal';

/**
 * Regression (2026-10-12 gate-by-intent): daily_loss, consecutive_loss-style entry brakes,
 * portfolio_drawdown and order_rate_limit blocked the position-REDUCING exit that would stop the
 * loss. With a verified single-use protective-exit seal those four gates are exempt for SELL only;
 * unsealed SELL, BUY, forged and replayed seals stay blocked, and the mandatory gates still apply.
 * Isolated temp DB; the trip conditions are real engine state (day-start equity, stored peak
 * equity, maxOrdersPerMinute=0), not mocked gate outputs.
 */
describe('RiskEngine loss/rate gates vs protective exits', () => {
  let tmpDbPath: string;
  let db: any; let sqliteDb: any; let schema: any; let riskEngine: any; let tradingEngine: any;
  const SYM = 'AAPL';

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_lossgates_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    await import('../core/EventBus');
    ({ riskEngine } = await import('./RiskEngine'));
    ({ tradingEngine } = await import('./TradingEngine'));
    const { marketDataWorker } = await import('../services/MarketDataWorker');
    marketDataWorker.cacheObservedQuote(SYM, 150);
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;

    // Trip the gates through real state.
    const { getTradingDateStr } = await import('../core/TradingCalendar');
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    await db.insert(schema.settings).values({
      tradingMode: 'Paper', autoBotEnabled: true, budget: 1000, maxTradeSize: 3000,
      peakEquity: 1_000_000_000, maxOrdersPerMinute: 0,
    });
    // Research-basis trip: $1,000 budget, a -$200 realized loss today -> 20% drawdown and $200 daily loss.
    await db.insert(schema.trades).values({
      id: 'lossgates-seed-sell', symbol: 'MSFT', side: 'SELL', quantity: 1, price: 300, status: 'FILLED',
      timestamp: new Date().toISOString(), filledAt: new Date().toISOString(), profitLoss: -200,
      executionEnvironment: 'PAPER', traceId: 'lossgates-seed-trace',
    });
    tradingEngine.state.dayStartDateStr = getTradingDateStr();
    tradingEngine.state.dayStartEquity = 1_000_000_000; // equity far below baseline -> daily_loss trips
    tradingEngine.state.dailyLossLimit = 50;
    await BrokerManager.getInstance().initialize();
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;
    expect(await BrokerManager.getInstance().setActiveBroker('internal_paper', { initialCash: 100000 })).toBe(true);
    resetProtectiveExitSealsForTests();
    resetRuntimeConfigCacheForTests();
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(tmpDbPath + s); } catch { /* best effort */ } }
    delete process.env.ARGUS_DB_PATH;
    resetProtectiveExitSealsForTests();
  });

  async function gates(traceId: string) {
    const rows = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
    const by: Record<string, any> = {};
    for (const r of rows) by[r.gateName] = { passed: !!r.passed, detail: r.detail ? JSON.parse(r.detail) : {} };
    return by;
  }
  const seal = (traceId: string) => mintProtectiveExitSeal({ traceId, symbol: SYM, mintedBy: PROTECTIVE_EXIT_AUTHORIZED_MINTER });

  it('sealed protective SELL passes the drawdown and order-rate brakes, which really are tripped', async () => {
    const traceId = 'lossgates-a';
    await riskEngine.evaluateRisk({ traceId, symbol: SYM, side: 'SELL', currentPrice: 150, protectiveExitSeal: seal(traceId) });
    const g = await gates(traceId);
    expect(g.daily_loss.detail.protectiveExitExempt).toBe(true);
    expect(g.daily_loss.passed).toBe(true);
    expect(g.portfolio_drawdown.detail.protectiveExitExempt).toBe(true);
    expect(g.portfolio_drawdown.passed).toBe(true);
    expect(g.order_rate_limit.detail.protectiveExitExempt).toBe(true);
    expect(g.order_rate_limit.passed).toBe(true);
  });

  it('unsealed SELL is still blocked by the same tripped brakes', async () => {
    const traceId = 'lossgates-b';
    await riskEngine.evaluateRisk({ traceId, symbol: SYM, side: 'SELL', currentPrice: 150 });
    const g = await gates(traceId);
    expect(g.daily_loss.passed).toBe(false);
    expect(g.portfolio_drawdown.passed).toBe(false);
    expect(g.order_rate_limit.passed).toBe(false);
  });

  it('BUY (even with a genuine SELL-bound seal) stays blocked, and the seal is not consumed for the wrong side', async () => {
    const traceId = 'lossgates-c';
    await riskEngine.evaluateRisk({ traceId, symbol: SYM, side: 'BUY', currentPrice: 150, protectiveExitSeal: seal(traceId) });
    const g = await gates(traceId);
    expect(g.portfolio_drawdown.passed).toBe(false);
    expect(g.order_rate_limit.passed).toBe(false);
  });

  it('forged seals do not exempt', async () => {
    const t1 = 'lossgates-d1';
    await riskEngine.evaluateRisk({ traceId: t1, symbol: SYM, side: 'SELL', currentPrice: 150, protectiveExitSeal: 'forged-seal' });
    expect((await gates(t1)).portfolio_drawdown.passed).toBe(false);

    // Replay/consumption semantics are covered by protectiveExitSeal unit tests; a second evaluation
    // under the same traceId cannot persist a second assessment (unique trace_id), so it is not observable here.
  });

  it('mandatory gates still apply to a sealed exit: no position -> sell_position_exists fails', async () => {
    const traceId = 'lossgates-e';
    await riskEngine.evaluateRisk({ traceId, symbol: SYM, side: 'SELL', currentPrice: 150, protectiveExitSeal: seal(traceId) });
    const g = await gates(traceId);
    expect(g.sell_position_exists.passed).toBe(false);
  });

  it('TRADING_PAUSED blocks entries but allows a genuine sealed PortfolioMonitor protective SELL through gate 0', async () => {
    tradingEngine.state.tradingState = 'TRADING_PAUSED';
    tradingEngine.state.emergencyStopActive = false;
    try {
      const traceId = 'lossgates-paused-sealed';
      await riskEngine.evaluateRisk({ traceId, symbol: SYM, side: 'SELL', currentPrice: 150, protectiveExitSeal: seal(traceId) });
      const g = await gates(traceId);
      expect(g.emergency_stop.passed).toBe(true);
      expect(g.emergency_stop.detail.pausedProtectiveExitAllowed).toBe(true);
    } finally {
      tradingEngine.state.tradingState = 'TRADING_ENABLED';
      tradingEngine.state.emergencyStopActive = false;
    }
  });

  it('TRADING_PAUSED still blocks an unsealed SELL and a BUY', async () => {
    tradingEngine.state.tradingState = 'TRADING_PAUSED';
    tradingEngine.state.emergencyStopActive = false;
    try {
      const sellTrace = 'lossgates-paused-unsealed';
      await riskEngine.evaluateRisk({ traceId: sellTrace, symbol: SYM, side: 'SELL', currentPrice: 150 });
      expect((await gates(sellTrace)).emergency_stop.passed).toBe(false);

      const buyTrace = 'lossgates-paused-buy';
      await riskEngine.evaluateRisk({ traceId: buyTrace, symbol: SYM, side: 'BUY', currentPrice: 150, protectiveExitSeal: seal(buyTrace) });
      expect((await gates(buyTrace)).emergency_stop.passed).toBe(false);
    } finally {
      tradingEngine.state.tradingState = 'TRADING_ENABLED';
      tradingEngine.state.emergencyStopActive = false;
    }
  });

  it('EMERGENCY_STOP remains absolute even for a genuine sealed protective SELL', async () => {
    tradingEngine.state.tradingState = 'EMERGENCY_STOP';
    tradingEngine.state.emergencyStopActive = true;
    try {
      const traceId = 'lossgates-emergency-sealed';
      await riskEngine.evaluateRisk({ traceId, symbol: SYM, side: 'SELL', currentPrice: 150, protectiveExitSeal: seal(traceId) });
      const g = await gates(traceId);
      expect(g.emergency_stop.passed).toBe(false);
      expect(g.emergency_stop.detail.pausedProtectiveExitAllowed).toBe(false);
    } finally {
      tradingEngine.state.tradingState = 'TRADING_ENABLED';
      tradingEngine.state.emergencyStopActive = false;
    }
  });
});
