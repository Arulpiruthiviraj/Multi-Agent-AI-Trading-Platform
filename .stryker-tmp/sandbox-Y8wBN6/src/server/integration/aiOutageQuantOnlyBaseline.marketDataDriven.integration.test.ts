// @ts-nocheck
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * Master Redesign Plan, Phase 3 ("Smallest quant-only baseline") - closes a real, specifically
 * named gap in the existing `aiOutageQuantOnlyBaseline.integration.test.ts`: that file's own
 * TechnicalAgent "idea" is a hardcoded `agent.reviewIdea({side:'BUY', confidence:0.88, agent:
 * 'TechnicalAgent', reasoning:'real RSI/MACD breakout...'})` call - a literal string asserting
 * realism, not an actual RSI/MACD computation. It proves the DOWNSTREAM half (ChiefTrader -> Risk
 * -> OMS -> fill with a genuinely empty AIRouter) but never exercises market data -> real
 * indicator math -> a naturally-emitted idea. This file adds that missing upstream half for one
 * of the two required independent agents.
 *
 * What is genuinely organic here: the real `technicalAgent` singleton (TechnicalAgent.ts) is
 * started, fed 50 real MARKET_DATA events carrying a price sequence independently verified
 * against the real evaluateTechnicalSignals() engine (see technicalSignal.test.ts's own
 * `risingTrendPrices` fixture, reused here at n=50 to match quantThresholds.technicalHistoryBars
 * exactly - re-verified via a standalone script against the current engine: BUY, confidence
 * 0.831, RSI 65.99, real MACD bullish crossover). The resulting TRADE_IDEA_GENERATED event is
 * captured from the real EventBus - never constructed by this test - and that captured, unedited
 * payload is what gets fed into ChiefTraderAgent.reviewIdea().
 *
 * What remains a known, explicitly-labeled gap (not closed by this file): the second required
 * independent voice (QuantEngine) is still a directly-constructed idea, not QuantSignalAgent's
 * own real evaluateSymbol() pipeline. Driving that organically requires real OHLCV bars plus real
 * regime/momentum/volume/support-resistance/market-context (including SPY/sector relative
 * strength) computation with no existing known-good bar-shape fixture in this repository -
 * substantially larger than this batch. See momentumBreakout.test.ts's baseFixture() for the
 * StrategyContext shape that would need to emerge naturally from seeded bars; that is the
 * concrete next step for full upstream coverage, tracked separately.
 *
 * Isolated temp SQLite DB - never data/argus.db. PAPER_TRADING_ONLY=true throughout, InternalPaperBroker
 * only, no LIVE_ARM anywhere in this file.
 */
describe('Phase 3 quant-only baseline (market-data-driven): a real TechnicalAgent-computed idea reaches a real PAPER fill with every AI provider unavailable', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let eventBus: any;
  let EVENTS: any;
  let BrokerManager: any;
  let tradingEngine: any;
  let marketDataWorker: any;
  let ChiefTraderAgent: any;
  let AIRouter: any;
  let technicalAgent: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_ai_outage_mdd_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.PAPER_TRADING_ONLY = 'true';

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ eventBus } = await import('../core/EventBus'));
    ({ EVENTS } = await import('../core/eventNames'));
    ({ BrokerManager } = await import('../../brokers/BrokerManager'));
    ({ tradingEngine } = await import('../engines/TradingEngine'));
    ({ marketDataWorker } = await import('../services/MarketDataWorker'));
    ({ ChiefTraderAgent } = await import('../services/ChiefTraderAgent'));
    ({ AIRouter } = await import('../ai/AIRouter'));
    ({ technicalAgent } = await import('../services/TechnicalAgent'));

    await import('../services/RiskAgent');
    await import('../services/OrderManagement');

    await db.insert(schema.settings).values({
      tradingMode: 'Paper', autoBotEnabled: true, budget: 100000, maxTradeSize: 3000,
      adversarialDebateMode: true,
    });

    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    tradingEngine.state.dayStartEquity = 100000;
    tradingEngine.state.dailyLossLimit = 5000;

    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;
    await BrokerManager.getInstance().initialize();
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;

    const ok = await BrokerManager.getInstance().setActiveBroker('internal_paper', { initialCash: 100000 });
    expect(ok).toBe(true);
  });

  afterAll(() => {
    technicalAgent.stop();
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  /** Same algorithm as technicalSignal.test.ts's risingTrendPrices, independently re-verified at
   *  n=50 (quantThresholds.technicalHistoryBars) against the live evaluateTechnicalSignals()
   *  engine before this file was written: BUY, confidence 0.831, RSI 65.99, real MACD bullish
   *  crossover, meanReversion/overbought both null. */
  function risingTrendPrices(n: number, start = 100): number[] {
    const trendBars = 15;
    const flatBars = Math.max(0, n - trendBars);
    const prices: number[] = [];
    for (let i = 0; i < flatBars; i++) prices.push(start + Math.sin(i / 7) * 0.3);
    let p = prices.length > 0 ? prices[prices.length - 1] : start;
    for (let i = 0; i < trendBars; i++) {
      p += (i % 3 === 2) ? -0.9 : 1.0;
      prices.push(p);
    }
    return prices;
  }

  it('reviewIdea() skips the debate (real hasAnyRoutableProvider()===false), and a genuinely TechnicalAgent-computed BUY idea (captured from the real EventBus, never constructed by this test) still reaches a real PAPER fill alongside one independent QuantEngine vote', async () => {
    const router = AIRouter.getInstance();
    router.clearProviders();
    expect(await router.hasAnyRoutableProvider()).toBe(false);

    const symbol = 'MDBUY';
    const traceId = `ai-outage-mdd-${Date.now()}`;
    const prices = risingTrendPrices(50);
    marketDataWorker.cacheObservedQuote(symbol, prices[prices.length - 1]);

    // Capture whatever TechnicalAgent's own real computation actually emits - this test never
    // builds this payload itself.
    const capturedIdeaPromise = new Promise<any>((resolve) => {
      const handler = (idea: any) => {
        if (idea.symbol === symbol && idea.agent === 'TechnicalAgent') {
          eventBus.off(EVENTS.TRADE_IDEA_GENERATED, handler);
          resolve(idea);
        }
      };
      eventBus.on(EVENTS.TRADE_IDEA_GENERATED, handler);
    });

    technicalAgent.start();
    for (const price of prices) {
      technicalAgent.analyzeTick({ symbol, price, volume: 1000, timestamp: new Date().toISOString() });
    }

    const realTechnicalIdea = await Promise.race([
      capturedIdeaPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('TechnicalAgent never emitted a real idea for ' + symbol)), 5000)),
    ]);

    // Prove it is genuinely computed, not this test's own fabrication: real indicator-derived
    // fields must be present and internally consistent with a real momentum-breakout BUY.
    expect(realTechnicalIdea.side).toBe('BUY');
    expect(realTechnicalIdea.reasoning).toMatch(/trend|MACD|RSI/i);
    expect(realTechnicalIdea.indicatorsSnapshot).toBeTruthy();
    expect(realTechnicalIdea.indicatorsSnapshot.rsi).toBeGreaterThan(50);
    expect(realTechnicalIdea.indicatorsSnapshot.rsi).toBeLessThan(70);
    expect(realTechnicalIdea.confidence).toBeGreaterThanOrEqual(0.6); // clears debateTriggerConfidence
    expect(realTechnicalIdea.traceId).toBeTruthy();

    const agent = new ChiefTraderAgent();
    agent.agentWeights = { TechnicalAgent: 1.0, QuantEngine: 1.0 };

    const ticker = setInterval(() => {
      BrokerManager.getInstance().tick({ [symbol]: prices[prices.length - 1] });
      eventBus.emit('MARKET_DATA', { symbol, price: prices[prices.length - 1], volume: 1000, timestamp: new Date().toISOString() });
    }, 100);

    try {
      // The real, captured TechnicalAgent idea - unedited, same traceId it was really emitted
      // with (not this test's own traceId variable).
      await agent.reviewIdea(realTechnicalIdea);
      // Known remaining gap (see file header): QuantEngine's second independent vote is still
      // directly constructed here, not driven through QuantSignalAgent.evaluateSymbol()'s own
      // real bar-based pipeline.
      await agent.reviewIdea({
        traceId: realTechnicalIdea.traceId, symbol, side: 'BUY', confidence: 0.85, agent: 'QuantEngine',
        reasoning: 'SYNTHETIC_SEEDED for this test - QuantSignalAgent.evaluateSymbol() organic path not yet wired into this integration test (tracked as the next concrete step)',
        currentPrice: prices[prices.length - 1],
      });

      let trade: any;
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const rows = await db.select().from(schema.trades).where(eq(schema.trades.traceId, realTechnicalIdea.traceId));
        trade = rows[0];
        if (trade && trade.status === 'FILLED' && trade.brokerOrderId) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(trade, 'the quant-only baseline pair should still reach a real fill when AI is down').toBeTruthy();
      expect(trade.status).toBe('FILLED');
      expect(trade.side).toBe('BUY');
      expect(trade.symbol).toBe(symbol);
      expect(trade.quantity).toBeGreaterThan(0);

      expect(agent.recentIdeas.some((i: any) => i.agent === 'ConsensusDebate')).toBe(false);

      const [assessment] = await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.traceId, realTechnicalIdea.traceId));
      expect(assessment.approved).toBe(true);

      expect(process.env.PAPER_TRADING_ONLY).toBe('true');
      expect(BrokerManager.getInstance().getActiveBroker().id).toBe('internal_paper');
    } finally {
      clearInterval(ticker);
    }
  }, 20000);
});
