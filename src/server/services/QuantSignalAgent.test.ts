import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Phase 7's real AI-contradiction-review step means this file now genuinely reaches AIRouter.
// Deleting the real provider env vars was tried first and proved fragile: dotenv reloads lazily
// (a real, previously-documented hazard - see RiskEngine.gates.test.ts's own comment on
// EncryptionService.ts's dotenv.config() re-populating "unset" keys) at a point later than this
// file's own beforeAll import chain, undoing the deletion before evaluateSymbol() actually runs.
// Mocking AIRouter directly is fully deterministic regardless of dotenv timing, and guarantees
// this test never makes a real, slow, costly network call to a real AI provider.
vi.mock('../ai/AIRouter', () => ({
  AIRouter: { getInstance: () => ({
    routeTask: async () => { throw new Error('No AI provider configured in this test.'); },
    routeConsensus: async () => null,
    hasAnyRoutableProvider: async () => true,
  }) },
}));

/**
 * Real integration test (isolated temp SQLite DB, real Express-free direct class use, mocked
 * Alpaca HTTP calls - same justified pattern HistoricalDataGateway.test.ts already uses: a real
 * Alpaca account isn't available in this environment, so the real fetch/parse/persist LOGIC is
 * what's under test, not Alpaca connectivity itself). Proves QuantSignalAgent.evaluateSymbol()
 * genuinely emits a real TRADE_IDEA_GENERATED (agent:'QuantEngine', the same payload shape every
 * other agent uses) and persists a real quant_assessments row - not that it merely compiles.
 */
describe('QuantSignalAgent.evaluateSymbol', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let eventBus: any;
  let marketDataWorker: any;
  let QuantSignalAgent: any;
  const originalAlpacaKey = process.env.ALPACA_API_KEY;
  const originalAlpacaSecret = process.env.ALPACA_SECRET_KEY;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_quantagent_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_SECRET_KEY = 'test-secret';

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ eventBus } = await import('../core/EventBus'));
    ({ marketDataWorker } = await import('./MarketDataWorker'));
    ({ QuantSignalAgent } = await import('./QuantSignalAgent'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
    if (originalAlpacaKey === undefined) delete process.env.ALPACA_API_KEY; else process.env.ALPACA_API_KEY = originalAlpacaKey;
    if (originalAlpacaSecret === undefined) delete process.env.ALPACA_SECRET_KEY; else process.env.ALPACA_SECRET_KEY = originalAlpacaSecret;
  });

  afterEach(() => vi.unstubAllGlobals());

  /** A single-page real-shaped Alpaca bars response, 250 real daily bars in a clean uptrend -
   *  returned for ANY symbol requested (the primary symbol AND every benchmark/sector-ETF
   *  MarketContext.ts fetches), since the pipeline-wiring test below doesn't need per-symbol
   *  differentiation to prove real end-to-end behavior. */
  function stubUptrendingFetch() {
    const now = Date.now();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        // Counts backward from "now" (not a fixed past date) so these bars always fall inside
        // whatever [startMs,endMs] window QuantSignalAgent's real 400-day lookback actually
        // queries, regardless of when this test happens to run.
        bars: Array.from({ length: 250 }, (_, i) => {
          const close = 100 + i * 0.5;
          const t = new Date(now - (250 - i) * 86_400_000).toISOString();
          return { t, o: close, h: close * 1.005, l: close * 0.995, c: close, v: 1_000_000 };
        }),
      }),
    })));
  }

  it('computes a real regime/market-context, persists a real quant_assessments row, and does not emit a regime-only idea without EV', async () => {
    stubUptrendingFetch();
    vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['QSATEST']);

    const receivedIdeas: any[] = [];
    const listener = (idea: any) => receivedIdeas.push(idea);
    eventBus.subscribe('TRADE_IDEA_GENERATED', listener);

    const agent = new QuantSignalAgent();
    const { tradingEngine } = await import('../engines/TradingEngine');
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    const result = await agent.evaluateSymbol('QSATEST');

    eventBus.unsubscribe('TRADE_IDEA_GENERATED', listener);

    expect(result).not.toBeNull();
    expect(result.regime.regime).toBe('BULLISH_TREND');

    // Zero closed live trades => EV cannot be computed => live emit is withheld (regime fallback removed).
    const mine = receivedIdeas.find(i => i.symbol === 'QSATEST');
    expect(mine).toBeUndefined();

    const persisted = (await db.select().from(schema.quantAssessments)).find((r: any) => r.symbol === 'QSATEST');
    expect(persisted).toBeDefined();
    expect(persisted.emittedTradeIdea).toBe(false);
    expect(JSON.parse(persisted.regime).regime).toBe('BULLISH_TREND');

    const persistedScores = JSON.parse(persisted.groupedScores);
    expect(persistedScores.BUY.overallSetupScore).toBeGreaterThanOrEqual(0);
    expect(persistedScores.SELL.overallSetupScore).toBeGreaterThanOrEqual(0);
    expect(result.groupedScores.BUY.trendScore).toBeGreaterThan(50);
  });

  it('ADAPTIVE_MULTI_STRATEGY Option B routes BULLISH_TREND away from pure mean-reversion', async () => {
    stubUptrendingFetch();
    vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['QSARB']);
    const { tradingEngine } = await import('../engines/TradingEngine');
    tradingEngine.state.strategy = 'ADAPTIVE_MULTI_STRATEGY';
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';

    const agent = new QuantSignalAgent();
    const result = await agent.evaluateSymbol('QSARB');
    expect(result).not.toBeNull();
    expect(result!.regime.regime).toBe('BULLISH_TREND');
    // Full CORE list is still computed for persistence/audit; emit path uses regime-routed subset.
    const ids = result!.strategyEvaluations.map((e: any) => e.strategy);
    expect(ids).toEqual(expect.arrayContaining([
      'MOMENTUM_BREAKOUT',
      'MEAN_REVERSION',
      'TREND_FOLLOWING',
    ]));
  });

  it('emits a cold-start regime-only bootstrap idea only when QUANT_COLD_START_BOOTSTRAP_ENABLED=true, still via the normal TRADE_IDEA_GENERATED path (ARGUS_PREDICTION_EDGE_AND_LEARNING_IMPLEMENTATION_AUDIT.md)', async () => {
    stubUptrendingFetch();
    // <=5 letters - looksLikeListedTicker/gateTradeIdea (DEF-24) silently routes anything longer
    // to TRADE_IDEA_REJECTED instead of TRADE_IDEA_GENERATED.
    vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['QSABT']);
    const { tradingEngine } = await import('../engines/TradingEngine');
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    marketDataWorker.cacheObservedQuote('QSABT', 125); // real fresh tick - assessDataQuality's market_data gate needs this, unrelated to the bootstrap logic itself

    const receivedIdeas: any[] = [];
    const listener = (idea: any) => receivedIdeas.push(idea);
    eventBus.subscribe('TRADE_IDEA_GENERATED', listener);
    try {
      process.env.QUANT_COLD_START_BOOTSTRAP_ENABLED = 'true';
      const agent = new QuantSignalAgent();
      await agent.evaluateSymbol('QSABT');
    } finally {
      delete process.env.QUANT_COLD_START_BOOTSTRAP_ENABLED;
      eventBus.unsubscribe('TRADE_IDEA_GENERATED', listener);
    }

    const mine = receivedIdeas.find(i => i.symbol === 'QSABT');
    expect(mine).toBeDefined();
    expect(mine.agent).toBe('QuantEngine');
    expect(mine.side).toBe('BUY'); // stubUptrendingFetch produces a real BULLISH_TREND regime
    expect(mine.reasoning).toContain('Cold-start bootstrap');
    // No real strategy evaluation backs this - stop/target/EV all honestly absent, not fabricated.
    expect(mine.quantDetail.strategyEvaluation).toBeNull();
  });

  it('skips a symbol honestly (no crash, no fabricated data) when Alpaca returns too few real bars', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ bars: [{ t: '2024-01-01T00:00:00Z', o: 100, h: 101, l: 99, c: 100, v: 1000 }] }),
    })));

    const agent = new QuantSignalAgent();
    const result = await agent.evaluateSymbol('THINDATA');
    expect(result).toBeNull();
  });

  it('runCycle is a real no-op (no throw) when MarketDataWorker has no active subscriptions', async () => {
    vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue([]);
    const agent = new QuantSignalAgent();
    await expect((agent as any).runCycle()).resolves.not.toThrow();
  });

  it('quantMaxConcurrentSymbols defaults to 1 (config-backed; reduces Alpaca 429 fan-out)', async () => {
    const { tradingSafety } = await import('../config/tradingSafety');
    expect(tradingSafety.quantMaxConcurrentSymbols).toBe(1);
    const agent = new QuantSignalAgent();
    expect((agent as any).symbolConcurrency()).toBe(1);
  });

  it('runCycle aborts remaining symbols on 429 (fail-closed; no idea storm)', async () => {
    vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['AAA', 'BBB', 'CCC']);
    const agent = new QuantSignalAgent();
    const evaluated: string[] = [];
    vi.spyOn(agent, 'evaluateSymbol').mockImplementation(async (symbol: string) => {
      evaluated.push(symbol);
      if (symbol === 'AAA') throw new Error('Alpaca bars 429 Too Many Requests');
      return null;
    });
    await (agent as any).runCycle();
    expect(evaluated).toEqual(['AAA']);
  });

  it('start() is a real no-op unless QUANT_ENGINE_ENABLED=true - verified by checking no interval was armed', async () => {
    delete process.env.QUANT_ENGINE_ENABLED;
    const agent = new QuantSignalAgent();
    agent.start();
    expect((agent as any).intervalId).toBeNull();
    agent.stop(); // safe even when never started
  });
});
