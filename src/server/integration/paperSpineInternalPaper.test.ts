import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * PAPER spine E2E (isolated temp SQLite — never data/argus.db):
 *   CHIEF_APPROVED_IDEA → RiskAgent → RiskEngine → OMS → InternalPaperBroker.placeOrder
 *   → MARKET_DATA / BrokerManager.tick fill → trades + fills persistence
 *
 * Does NOT insert fake fills into the DB as success. Fill must come from the real
 * InternalPaperBroker.tick() path that OMS polls (same as production InternalPaper).
 * clientOrderId contract: OMS uses the local trades.id as placeOrder({ clientOrderId }).
 */
describe('PAPER spine: CHIEF_APPROVED_IDEA → Risk → OMS → InternalPaper fill', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let eventBus: any;
  let BrokerManager: any;
  let tradingEngine: any;
  let marketDataWorker: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_paper_spine_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.PAPER_TRADING_ONLY = 'true';

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ eventBus } = await import('../core/EventBus'));
    ({ BrokerManager } = await import('../../brokers/BrokerManager'));
    ({ tradingEngine } = await import('../engines/TradingEngine'));
    ({ marketDataWorker } = await import('../services/MarketDataWorker'));

    // Real listener fan-out: RiskAgent (CHIEF → evaluateRisk) + OMS (RISK_ASSESSMENT_COMPLETED → placeOrder).
    await import('../services/RiskAgent');
    await import('../services/OrderManagement');

    await db.insert(schema.settings).values({
      tradingMode: 'Paper',
      autoBotEnabled: true,
      budget: 100000,
      maxTradeSize: 3000,
    });

    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    tradingEngine.state.dayStartEquity = 100000;
    tradingEngine.state.dailyLossLimit = 5000;

    // After dotenv side-effects from EncryptionService / BrokerManager imports, clear Alpaca so
    // market_hours short-circuits to unconfigured/skip (no live clock dependency).
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;

    await BrokerManager.getInstance().initialize();
    const ok = await BrokerManager.getInstance().setActiveBroker('internal_paper', { initialCash: 100000 });
    expect(ok).toBe(true);
    expect(BrokerManager.getInstance().getActiveBroker().id).toBe('internal_paper');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('approves via real RiskEngine, places via OMS, fills on tick, persists unique trade+fill (no fabricated DB fill)', async () => {
    const symbol = 'PSPN';
    const price = 50;
    const traceId = `paper-spine-${Date.now()}`;

    marketDataWorker.cacheObservedQuote(symbol, price);

    // Drive InternalPaper fills while OMS pollForFill is waiting (placeOrder returns PENDING).
    const ticker = setInterval(() => {
      BrokerManager.getInstance().tick({ [symbol]: price });
      eventBus.emit('MARKET_DATA', { symbol, price, volume: 1000, timestamp: new Date().toISOString() });
    }, 100);

    try {
      eventBus.emit('CHIEF_APPROVED_IDEA', {
        transactionId: undefined,
        traceId,
        symbol,
        side: 'BUY',
        confidence: 0.9,
        reasoning: 'paper-spine integration fixture (ChiefTrader consensus already decided)',
        agentsContext: 'TechnicalAgent+NewsAgent fixture',
        currentPrice: price,
        evidence: [],
      });

      let trade: any;
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const rows = await db.select().from(schema.trades).where(eq(schema.trades.traceId, traceId));
        trade = rows[0];
        if (trade && trade.status === 'FILLED' && trade.brokerOrderId) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(trade, 'OMS should have inserted a trades row for the approved assessment').toBeTruthy();
      expect(trade.status).toBe('FILLED');
      expect(trade.side).toBe('BUY');
      expect(trade.symbol).toBe(symbol);
      expect(trade.quantity).toBeGreaterThan(0);
      expect(trade.price).toBeGreaterThan(0);
      expect(trade.brokerOrderId).toBeTruthy();
      // OMS clientOrderId contract: local trades.id is passed as placeOrder({ clientOrderId })
      // and stored as requestId — never invent a second idempotency key.
      expect(trade.requestId).toBe(trade.id);
      expect(trade.executionEnvironment === 'PAPER' || String(trade.reasoning || '').includes('PAPER')).toBe(true);

      const fillRows = await db.select().from(schema.fills).where(eq(schema.fills.orderId, trade.id));
      expect(fillRows.length).toBeGreaterThanOrEqual(1);
      expect(fillRows.reduce((s: number, r: { quantity: number }) => s + r.quantity, 0)).toBe(trade.quantity);
      expect(fillRows[0].cumulativeQuantity).toBe(trade.quantity);

      // Uniqueness: a second incremental fill at the same cumulative watermark is a no-op
      // (real fillLedger path — not a hand-inserted fake success row).
      const { insertIncrementalFill } = await import('../services/fillLedger');
      const dup = await insertIncrementalFill({
        orderId: trade.id,
        brokerOrderId: trade.brokerOrderId,
        requestedQuantity: trade.quantity,
        status: 'FILLED',
        filledQuantity: trade.quantity,
        averageFillPrice: trade.price,
      });
      expect(dup.newQty).toBe(0);
      expect(dup.duplicate || dup.cumulativeQuantity === trade.quantity).toBe(true);
      const fillsAfter = await db.select().from(schema.fills).where(eq(schema.fills.orderId, trade.id));
      expect(fillsAfter).toHaveLength(fillRows.length);

      const [assessment] = await db.select().from(schema.riskAssessments)
        .where(eq(schema.riskAssessments.traceId, traceId));
      expect(assessment.approved).toBe(true);
      expect(assessment.maxQuantity).toBeGreaterThan(0);
    } finally {
      clearInterval(ticker);
    }
  }, 20000);

  it('EMERGENCY_STOP blocks a subsequent BUY on the same spine (kill switch) without a second placeOrder path', async () => {
    const symbol = 'PKIL';
    const price = 40;
    marketDataWorker.cacheObservedQuote(symbol, price);
    tradingEngine.state.tradingState = 'EMERGENCY_STOP';
    tradingEngine.state.emergencyStopActive = true;

    const placeSpyCountsBefore = (await db.select().from(schema.trades)).length;
    const traceId = `paper-spine-kill-${Date.now()}`;

    eventBus.emit('CHIEF_APPROVED_IDEA', {
      traceId,
      symbol,
      side: 'BUY',
      confidence: 0.9,
      reasoning: 'should be blocked by emergency_stop',
      agentsContext: '',
      currentPrice: price,
      evidence: [],
    });

    let assessment: any;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const rows = await db.select().from(schema.riskAssessments)
        .where(eq(schema.riskAssessments.traceId, traceId));
      assessment = rows[0];
      if (assessment) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(assessment).toBeTruthy();
    expect(assessment.approved).toBe(false);
    expect(assessment.rejectionGate).toBe('emergency_stop');

    const tradesAfter = await db.select().from(schema.trades).where(eq(schema.trades.traceId, traceId));
    expect(tradesAfter).toHaveLength(0);
    expect((await db.select().from(schema.trades)).length).toBe(placeSpyCountsBefore);

    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    tradingEngine.state.emergencyStopActive = false;
  }, 10000);
});
