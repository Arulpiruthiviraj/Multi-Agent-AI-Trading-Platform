import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * Phase 13 (ARGUS_PRE_IMPLEMENTATION_BASELINE.md) - real end-to-end integration proof that
 * restricted live mode's hardcoded caps actually reach RiskEngine's real sizing math, not just the
 * pure function in isolation (RestrictedLiveMode.test.ts). Real isolated temp SQLite DB, real
 * BrokerManager (InternalPaperBroker default, real $100k starting cash), real RiskEngine -
 * deliberately configures `settings.maxTradeSize` to an absurdly permissive value and proves the
 * real order size is still capped at the hardcoded restricted-live ceiling once
 * tradingEngine.state.tradingMode is set to 'LIVE'.
 */
describe('RiskEngine - restricted live mode caps (Phase 13)', { timeout: 60000 }, () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let riskEngine: any;
  let tradingEngine: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_restrictedlive_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ riskEngine } = await import('./RiskEngine'));
    ({ tradingEngine } = await import('./TradingEngine'));
    const { marketDataWorker } = await import('../services/MarketDataWorker');
    marketDataWorker.cacheObservedQuote('AAPL', 100);
    marketDataWorker.cacheObservedQuote('MSFT', 100);
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';

    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;

    // Deliberately permissive settings - the real point of this test is that the hardcoded
    // restricted-live ceiling still binds regardless of what this row says.
    await db.insert(schema.settings).values({ maxTradeSize: 1_000_000, riskLevel: 'Aggressive', maxOpenPositions: 999 });
  }, 60_000);

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('caps real order notional at the hardcoded restricted-live ceiling in LIVE mode, despite a permissive settings row', async () => {
    tradingEngine.state.tradingMode = 'PAPER';
    const paperTraceId = 'restricted-live-paper-baseline';
    await riskEngine.evaluateRisk({ traceId: paperTraceId, symbol: 'AAPL', side: 'BUY', currentPrice: 100 });
    const [paperAssessment] = await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.traceId, paperTraceId));
    // In paper mode, the permissive $1,000,000 settings cap is what actually binds (or buying
    // power does) - either way, maxQuantity should reflect the UNrestricted settings value, not
    // the restricted-live ceiling.
    expect(paperAssessment.maxQuantity).toBeGreaterThan(50); // 5000/100 = 50 would be the restricted-live ceiling in shares

    tradingEngine.state.tradingMode = 'LIVE';
    const liveTraceId = 'restricted-live-actual';
    await riskEngine.evaluateRisk({ traceId: liveTraceId, symbol: 'MSFT', side: 'BUY', currentPrice: 100 });
    const [liveAssessment] = await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.traceId, liveTraceId));
    const gateRows = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, liveTraceId));
    const notionalGate = gateRows.find((g: any) => g.gateName === 'order_notional_cap');
    const detail = JSON.parse(notionalGate.detail);

    // $5,000 hardcoded ceiling / $100 price = exactly 50 shares, regardless of the $1,000,000 setting.
    expect(detail.maxTradeSizeDollar).toBeLessThanOrEqual(5000);
    expect(liveAssessment.maxQuantity).toBeLessThanOrEqual(50);

    tradingEngine.state.tradingMode = 'PAPER'; // cleanup
  });
});
