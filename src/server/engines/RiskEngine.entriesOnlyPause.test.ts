import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';
import { resetRuntimeConfigCacheForTests } from '../config/effectiveRuntimeConfig';
import { mintProtectiveExitSeal, resetProtectiveExitSealsForTests, PROTECTIVE_EXIT_AUTHORIZED_MINTER } from '../core/protectiveExitSeal';

/**
 * 2026-10-13 (overnight shutdown / Oct 12 pause blocked the S exit): an ENTRIES_ONLY pause (boot restart-safety, opt-in)
 * blocks new entries but lets a SEALED protective SELL pass the emergency_stop gate; everything else stays blocked.
 * Real RiskEngine, isolated DB; the pause is set through the real setTradingState() path.
 */
describe('RiskEngine emergency_stop gate vs ENTRIES_ONLY pause', () => {
  let tmp: string; let db: any; let sqliteDb: any; let schema: any; let riskEngine: any; let tradingEngine: any;
  const SYM = 'AAPL';

  beforeAll(async () => {
    tmp = path.join(os.tmpdir(), `argus_entriesonly_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmp;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    await import('../core/EventBus');
    ({ riskEngine } = await import('./RiskEngine'));
    ({ tradingEngine } = await import('./TradingEngine'));
    const { marketDataWorker } = await import('../services/MarketDataWorker');
    marketDataWorker.cacheObservedQuote(SYM, 150);
    delete process.env.ALPACA_API_KEY; delete process.env.ALPACA_SECRET_KEY;
    const { getTradingDateStr } = await import('../core/TradingCalendar');
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    await db.insert(schema.settings).values({ tradingMode: 'Paper', autoBotEnabled: true, budget: 100000, maxTradeSize: 3000 });
    tradingEngine.state.enabled = true;
    tradingEngine.state.dayStartDateStr = getTradingDateStr();
    tradingEngine.state.dayStartEquity = 100000;
    tradingEngine.state.dailyLossLimit = 5000;
    await BrokerManager.getInstance().initialize();
    delete process.env.ALPACA_API_KEY; delete process.env.ALPACA_SECRET_KEY;
    expect(await BrokerManager.getInstance().setActiveBroker('internal_paper', { initialCash: 100000 })).toBe(true);
    resetProtectiveExitSealsForTests();
    resetRuntimeConfigCacheForTests();
  });
  afterAll(() => {
    try { sqliteDb.close(); } catch { /* closed */ }
    for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(tmp + s); } catch { /* best effort */ } }
    delete process.env.ARGUS_DB_PATH;
    resetProtectiveExitSealsForTests();
  });
  beforeEach(() => resetProtectiveExitSealsForTests());

  async function gate(traceId: string, name: string) {
    const rows = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
    const g = rows.find((r: any) => r.gateName === name);
    expect(g).toBeDefined();
    return { passed: !!g.passed, detail: g.detail ? JSON.parse(g.detail) : {} };
  }
  const seal = (traceId: string) => mintProtectiveExitSeal({ traceId, symbol: SYM, mintedBy: PROTECTIVE_EXIT_AUTHORIZED_MINTER });
  const pause = (kind?: 'ENTRIES_ONLY') => tradingEngine.setTradingState('TRADING_PAUSED', { reason: 'test pause', actor: 'test', pauseKind: kind });

  it('setTradingState records the pause kind and resets it on any other transition', async () => {
    await pause('ENTRIES_ONLY');
    expect(tradingEngine.state.pauseKind).toBe('ENTRIES_ONLY');
    await pause();
    expect(tradingEngine.state.pauseKind).toBe('FULL');
    await pause('ENTRIES_ONLY');
    await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'resume', actor: 'test', pauseKind: 'ENTRIES_ONLY' });
    expect(tradingEngine.state.pauseKind).toBe('FULL'); // a pauseKind on a non-pause transition is ignored
  });

  it('ENTRIES_ONLY pause: a sealed protective SELL passes emergency_stop', async () => {
    await pause('ENTRIES_ONLY');
    const traceId = 'eo-sealed-sell';
    await riskEngine.evaluateRisk({ traceId, symbol: SYM, side: 'SELL', currentPrice: 150, protectiveExitSeal: seal(traceId) });
    const g = await gate(traceId, 'emergency_stop');
    expect(g.passed).toBe(true);
    expect(g.detail.protectiveExitExempt).toBe(true);
    expect(g.detail.pauseKind).toBe('ENTRIES_ONLY');
  });

  it('ENTRIES_ONLY pause still blocks new entries, unsealed SELLs, and forged seals', async () => {
    await pause('ENTRIES_ONLY');
    await riskEngine.evaluateRisk({ traceId: 'eo-buy', symbol: SYM, side: 'BUY', currentPrice: 150 });
    expect((await gate('eo-buy', 'emergency_stop')).passed).toBe(false);
    await riskEngine.evaluateRisk({ traceId: 'eo-unsealed', symbol: SYM, side: 'SELL', currentPrice: 150 });
    expect((await gate('eo-unsealed', 'emergency_stop')).passed).toBe(false);
    await riskEngine.evaluateRisk({ traceId: 'eo-forged', symbol: SYM, side: 'SELL', currentPrice: 150, protectiveExitSeal: 'forged' });
    expect((await gate('eo-forged', 'emergency_stop')).passed).toBe(false);
  });

  it('a FULL pause (every existing pause source) still blocks even a sealed protective SELL', async () => {
    await pause();
    const traceId = 'full-sealed-sell';
    await riskEngine.evaluateRisk({ traceId, symbol: SYM, side: 'SELL', currentPrice: 150, protectiveExitSeal: seal(traceId) });
    const g = await gate(traceId, 'emergency_stop');
    expect(g.passed).toBe(false);
    expect(g.detail.protectiveExitExempt).toBe(false);
  });

  it('EMERGENCY_STOP is never exempt, even with a sealed protective SELL', async () => {
    await tradingEngine.setTradingState('EMERGENCY_STOP', { reason: 'test', actor: 'test', pauseKind: 'ENTRIES_ONLY' });
    const traceId = 'es-sealed-sell';
    await riskEngine.evaluateRisk({ traceId, symbol: SYM, side: 'SELL', currentPrice: 150, protectiveExitSeal: seal(traceId) });
    expect((await gate(traceId, 'emergency_stop')).passed).toBe(false);
  });

  it('mandatory gates still apply to a sealed exit under ENTRIES_ONLY: no position -> sell_position_exists fails', async () => {
    await pause('ENTRIES_ONLY');
    const traceId = 'eo-no-position';
    await riskEngine.evaluateRisk({ traceId, symbol: SYM, side: 'SELL', currentPrice: 150, protectiveExitSeal: seal(traceId) });
    expect((await gate(traceId, 'sell_position_exists')).passed).toBe(false);
  });
});
