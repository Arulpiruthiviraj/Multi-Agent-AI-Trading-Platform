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

  /**
   * Real bug found and fixed (2026-08-25, post-audit hardening, Phase 6): no existing test
   * proved a SELL/exit idea traveling through the SAME real spine as the BUY test above
   * (RiskAgent -> RiskEngine -> OMS -> InternalPaperBroker -> fill -> localPortfolioSync ->
   * portfolio row updated). PipelineFlatten.test.ts covers the separate manual-liquidation
   * override path (skips consensus, not RiskEngine per CLAUDE.md), which is not the same
   * thing as a normal consensus-approved SELL against a real open position. This test opens
   * a real position first (via the identical CHIEF_APPROVED_IDEA BUY path proven above), then
   * exits it the same way, verifying sell_position_exists passes, the position quantity
   * reduces to zero via the real localPortfolioSync path, and the sale is a genuine second
   * fill row, not a fabricated success.
   */
  it('opens a real position via BUY, then exits it via SELL through the same real spine (sell_position_exists, fill, position closed)', async () => {
    const symbol = 'PSEL';
    const buyPrice = 30;
    const sellPrice = 31;
    const buyTraceId = `paper-spine-sell-buy-${Date.now()}`;
    const sellTraceId = `paper-spine-sell-exit-${Date.now()}`;

    marketDataWorker.cacheObservedQuote(symbol, buyPrice);
    const ticker = setInterval(() => {
      BrokerManager.getInstance().tick({ [symbol]: buyPrice });
      eventBus.emit('MARKET_DATA', { symbol, price: buyPrice, volume: 1000, timestamp: new Date().toISOString() });
    }, 100);

    let buyTrade: any;
    try {
      eventBus.emit('CHIEF_APPROVED_IDEA', {
        traceId: buyTraceId,
        symbol,
        side: 'BUY',
        confidence: 0.9,
        reasoning: 'paper-spine SELL-test fixture: open the position first',
        agentsContext: 'TechnicalAgent+NewsAgent fixture',
        currentPrice: buyPrice,
        evidence: [],
      });

      const buyDeadline = Date.now() + 12000;
      while (Date.now() < buyDeadline) {
        const rows = await db.select().from(schema.trades).where(eq(schema.trades.traceId, buyTraceId));
        buyTrade = rows[0];
        if (buyTrade && buyTrade.status === 'FILLED') break;
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      clearInterval(ticker);
    }

    expect(buyTrade, 'setup BUY must fill for this test to open a real position').toBeTruthy();
    expect(buyTrade.status).toBe('FILLED');

    // Real position now exists locally via syncLocalPortfolioAfterBuyFill (OMS's own fill-processing
    // path, not asserted-into-existence by this test).
    const [openPosition] = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, symbol));
    expect(openPosition, 'BUY fill should have created a real local portfolio row').toBeTruthy();
    expect(openPosition.quantity).toBe(buyTrade.quantity);

    // Now exit it — same real spine, SELL side, existing position.
    marketDataWorker.cacheObservedQuote(symbol, sellPrice);
    const sellTicker = setInterval(() => {
      BrokerManager.getInstance().tick({ [symbol]: sellPrice });
      eventBus.emit('MARKET_DATA', { symbol, price: sellPrice, volume: 1000, timestamp: new Date().toISOString() });
    }, 100);

    let sellTrade: any;
    try {
      eventBus.emit('CHIEF_APPROVED_IDEA', {
        traceId: sellTraceId,
        symbol,
        side: 'SELL',
        confidence: 0.9,
        reasoning: 'paper-spine SELL-test fixture: exit the position',
        agentsContext: 'PortfolioMonitor fixture',
        currentPrice: sellPrice,
        evidence: [],
      });

      const sellDeadline = Date.now() + 12000;
      while (Date.now() < sellDeadline) {
        const rows = await db.select().from(schema.trades).where(eq(schema.trades.traceId, sellTraceId));
        sellTrade = rows[0];
        if (sellTrade && sellTrade.status === 'FILLED') break;
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      clearInterval(sellTicker);
    }

    expect(sellTrade, 'OMS should have inserted a trades row for the approved SELL assessment').toBeTruthy();
    expect(sellTrade.status).toBe('FILLED');
    expect(sellTrade.side).toBe('SELL');
    expect(sellTrade.symbol).toBe(symbol);
    expect(sellTrade.quantity).toBeGreaterThan(0);
    expect(sellTrade.brokerOrderId).toBeTruthy();
    expect(sellTrade.id).not.toBe(buyTrade.id); // genuine second order, not the same row re-read

    // sell_position_exists must be recorded and must have passed (a real position existed).
    const [sellAssessment] = await db.select().from(schema.riskAssessments)
      .where(eq(schema.riskAssessments.traceId, sellTraceId));
    expect(sellAssessment.approved).toBe(true);
    const sellGates = await db.select().from(schema.riskGateResults)
      .where(eq(schema.riskGateResults.traceId, sellAssessment.traceId));
    const sellPositionGate = sellGates.find((g: { gateName: string }) => g.gateName === 'sell_position_exists');
    expect(sellPositionGate, 'sell_position_exists must be recorded for a SELL assessment').toBeTruthy();
    expect(sellPositionGate!.passed).toBe(true);

    // Real fill, not fabricated: a distinct fills row tied to the SELL order.
    const sellFillRows = await db.select().from(schema.fills).where(eq(schema.fills.orderId, sellTrade.id));
    expect(sellFillRows.length).toBeGreaterThanOrEqual(1);

    // Position closed via the real syncLocalPortfolioAfterSellFill path (full close -> row deleted),
    // not asserted directly — this test only reads the result of that real code path.
    const remainingPosition = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, symbol));
    expect(remainingPosition).toHaveLength(0);
  }, 30000);
});
