import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * 2026-10-13 research-capital consistency. Daily-loss / drawdown / allocation already measured Argus's $20,000
 * research capital; the percent-of-capital SIZING caps (single-symbol concentration, sector, correlated exposure,
 * portfolio-risk amount) still scaled with the ~$1M simulated broker account. With a broker equity of $1,000,000 and
 * a research budget of exactly $20,000 the caps must come from $20,000, and broker buying power must not enlarge them.
 * Real RiskEngine + real PositionSizing + isolated temp DB + simulated internal-paper broker.
 */
describe('RiskEngine sizing caps use research capital, not broker equity', () => {
  let tmpDbPath: string;
  let db: any; let sqliteDb: any; let schema: any; let riskEngine: any; let tradingEngine: any; let tradingSafety: any;
  const SYM = 'AAPL';
  const BROKER_EQUITY = 1_000_000;
  const BUDGET = 20_000;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_researchcaps_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    await import('../core/EventBus');
    ({ riskEngine } = await import('./RiskEngine'));
    ({ tradingEngine } = await import('./TradingEngine'));
    ({ tradingSafety } = await import('../config/tradingSafety'));
    const { marketDataWorker } = await import('../services/MarketDataWorker');
    marketDataWorker.cacheObservedQuote(SYM, 150);
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    await db.insert(schema.settings).values({
      tradingMode: 'Paper', autoBotEnabled: true, budget: BUDGET, maxTradeSize: 1_000_000, maxOrdersPerMinute: 100,
      maxOpenPositions: 10,
    });
    await BrokerManager.getInstance().initialize();
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;
    expect(await BrokerManager.getInstance().setActiveBroker('internal_paper', { initialCash: BROKER_EQUITY })).toBe(true);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* closed */ }
    for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(tmpDbPath + s); } catch { /* best effort */ } }
    delete process.env.ARGUS_DB_PATH;
  });

  async function gates(traceId: string) {
    const rows = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
    const by: Record<string, any> = {};
    for (const r of rows) by[r.gateName] = { passed: !!r.passed, detail: r.detail ? JSON.parse(r.detail) : {} };
    return by;
  }

  it('single-symbol concentration cap derives from $20,000 research capital (not $1,000,000 broker equity)', async () => {
    expect(tradingSafety.researchEquityRiskBasisEnabled).toBe(true);
    const traceId = 'researchcaps-a';
    await riskEngine.evaluateRisk({ traceId, symbol: SYM, side: 'BUY', currentPrice: 150 });
    const g = await gates(traceId);
    expect(g.invalid_account_equity.detail.equity).toBe(BROKER_EQUITY); // broker figure still drives only the validity gate
    const cap = g.symbol_concentration.detail.maxPositionValue;
    expect(cap).toBeCloseTo(BUDGET * tradingSafety.maxSingleSymbolConcentrationPct, 6);
    expect(cap).toBeLessThan(BROKER_EQUITY * tradingSafety.maxSingleSymbolConcentrationPct / 10);
  });

  it('correlated-exposure cap and the sized quantity respect research capital even with a huge maxTradeSize and $3M+ buying power', async () => {
    const traceId = 'researchcaps-b';
    await riskEngine.evaluateRisk({ traceId, symbol: SYM, side: 'BUY', currentPrice: 150 });
    const g = await gates(traceId);
    if (g.correlation_exposure.detail.maxCorrelatedValue !== undefined) {
      expect(g.correlation_exposure.detail.maxCorrelatedValue).toBeCloseTo(BUDGET * tradingSafety.maxCorrelatedExposurePct, 6);
    }
    const a = (await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.traceId, traceId)))[0];
    expect(a.maxQuantity * 150).toBeLessThanOrEqual(BUDGET * tradingSafety.maxSingleSymbolConcentrationPct + 150);
    expect(a.buyingPower).toBeGreaterThan(BUDGET * 10); // the broker's buying power really was huge and did not widen anything
  });
});
