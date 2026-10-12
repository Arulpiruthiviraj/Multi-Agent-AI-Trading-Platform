import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Proves Quant can emit TRADE_IDEA_GENERATED when a deterministic fixture satisfies
 * strategy + live EV + min R:R. Does not weaken production thresholds.
 */
vi.mock('../core/dataQuality', () => ({
  assessDataQuality: () => ({
    overall: 'GREEN',
    tradeBlocked: false,
    blockReason: null,
    channels: [],
  }),
}));

vi.mock('../ai/AIRouter', () => ({
  AIRouter: { getInstance: () => ({
    routeTask: async () => { throw new Error('No AI provider configured in this test.'); },
    routeConsensus: async () => null,
    hasAnyRoutableProvider: async () => true,
  }) },
}));

vi.mock('../quant/risk/LiveStrategyPerformance', () => ({
  computeLiveStrategyWinRate: async () => ({
    strategyId: 'MOMENTUM_BREAKOUT',
    sampleSize: 30,
    wins: 21,
    losses: 9,
    winProbability: 0.7,
  }),
}));

vi.mock('../quant/strategies/StrategyEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../quant/strategies/StrategyEngine')>();
  return {
    ...actual,
    evaluateAll: (ctx: { currentPrice: number }) => [{
      strategy: 'MOMENTUM_BREAKOUT',
      side: 'BUY',
      setupScore: 90,
      confidence: 0.85,
      conditionsMet: ['fixture breakout'],
      conditionsFailed: [],
      contradictions: [],
      invalidationConditions: [],
      stop: { price: ctx.currentPrice * 0.9, basis: 'fixture stop' },
      target: { price: ctx.currentPrice * 1.2, basis: 'fixture target' },
      applicableRegimes: ['BULLISH_TREND'],
    }],
    bestStrategyIdea: () => ({
      side: 'BUY',
      confidence: 0.85,
      strategy: 'MOMENTUM_BREAKOUT',
      reasoning: 'QuantEngine/MOMENTUM_BREAKOUT fixture',
    }),
  };
});

describe('QuantSignalAgent emit fixture (strategy + EV satisfied)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let eventBus: any;
  let marketDataWorker: any;
  let QuantSignalAgent: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_quant_emit_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.ALPACA_API_KEY = process.env.ALPACA_API_KEY || 'test-key';
    process.env.ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY || 'test-secret';
    ({ sqliteDb } = await import('../db'));
    ({ eventBus } = await import('../core/EventBus'));
    ({ marketDataWorker } = await import('./MarketDataWorker'));
    ({ QuantSignalAgent } = await import('./QuantSignalAgent'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
  });

  afterEach(() => vi.unstubAllGlobals());

  function stubMarketData() {
    const now = Date.now();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        bars: Array.from({ length: 80 }, (_, i) => {
          const close = 100 + i * 0.1;
          return {
            t: new Date(now - (80 - i) * 86_400_000).toISOString(),
            o: close, h: close * 1.005, l: close * 0.995, c: close, v: 1_000_000,
          };
        }),
      }),
    })));
    vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['QFIX']);
    vi.spyOn(marketDataWorker, 'getLatestPriceAgeMs').mockReturnValue(1000);
  }

  it('records the restart hold for an eligible candidate without emitting an idea', async () => {
    stubMarketData();
    const { forceHoldNewEntryIdeasForTests } = await import('../core/sessionRecovery');
    const { tradingEngine } = await import('../engines/TradingEngine');
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    const ideas: any[] = [];
    const refusals: any[] = [];
    const onIdea = (p: any) => ideas.push(p);
    const onRefusal = (p: any) => refusals.push(p);
    eventBus.subscribe('TRADE_IDEA_GENERATED', onIdea);
    eventBus.subscribe('DESK_NO_TRADE', onRefusal);
    forceHoldNewEntryIdeasForTests(true);
    try {
      await new QuantSignalAgent().evaluateSymbol('QHELD');
      expect(ideas).toEqual([]);
      expect(refusals).toEqual([expect.objectContaining({ symbol: 'QHELD', code: 'IDEA_GENERATION_GATED' })]);
      expect(sqliteDb.prepare('SELECT emitted_trade_idea FROM quant_assessments WHERE symbol=?').get('QHELD')).toEqual({ emitted_trade_idea: 0 });
    } finally {
      forceHoldNewEntryIdeasForTests(false);
      eventBus.unsubscribe('TRADE_IDEA_GENERATED', onIdea);
      eventBus.unsubscribe('DESK_NO_TRADE', onRefusal);
    }
  });

  it('emits QuantEngine TRADE_IDEA_GENERATED when the fixture clears EV and R:R', async () => {
    stubMarketData();

    const received: any[] = [];
    const rejected: any[] = [];
    const listener = (idea: any) => received.push(idea);
    eventBus.subscribe('TRADE_IDEA_GENERATED', listener);
    eventBus.subscribe('TRADE_IDEA_REJECTED', (p: any) => rejected.push(p));

    const { tradingEngine } = await import('../engines/TradingEngine');
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';

    const agent = new QuantSignalAgent();
    const result = await agent.evaluateSymbol('QFIX');
    eventBus.unsubscribe('TRADE_IDEA_GENERATED', listener);

    expect(result).not.toBeNull();
    const mine = received.find(i => i.symbol === 'QFIX' && i.agent === 'QuantEngine');
    expect(rejected).toEqual([]);
    expect(mine).toBeDefined();
    expect(mine.side).toBe('BUY');
    expect(mine.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('M1: withholds emission when isLiveCheck flips false between the early check and the point of emission', async () => {
    stubMarketData();
    const { tradingEngine } = await import('../engines/TradingEngine');
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';

    const ideas: any[] = [];
    const noTrades: any[] = [];
    const onIdea = (p: any) => ideas.push(p);
    const onNoTrade = (p: any) => noTrades.push(p);
    let calls = 0;
    eventBus.subscribe('TRADE_IDEA_GENERATED', onIdea);
    eventBus.subscribe('DESK_NO_TRADE', onNoTrade);
    try {
      const agent = new QuantSignalAgent();
      // The FIRST isLiveCheck() call (the early pre-await check) reports live; every
      // later call reports expired - simulating the scheduler quarantining the
      // evaluation in flight, after the early check but before the point of emission.
      // Without the 2026-10-12 final point-of-emission gate this idea WOULD emit (the
      // early check passed), so this test discriminates the final gate directly.
      // Cooperative stage fences (throwIfSuperseded) also consult isLiveCheck. The early check and the
      // point-of-emission gate call it DIRECTLY from evaluateSymbol; the fences call it via
      // throwIfSuperseded. Stay live for every fence and for the first direct call; report not-live on the
      // second direct call - the point-of-emission gate, which is what this test must discriminate.
      let direct = 0;
      const result = await agent.evaluateSymbol('QFIX', {
        emitIdeas: true,
        isLiveCheck: () => {
          calls += 1;
          if ((new Error().stack || '').includes('throwIfSuperseded')) return true;
          direct += 1;
          return direct <= 1;
        },
      });
      expect(result).not.toBeNull();
      const mine = ideas.find(i => i.symbol === 'QFIX' && i.agent === 'QuantEngine');
      expect(mine).toBeUndefined();
      const withheld = noTrades.find(n => n.symbol === 'QFIX' && n.code === 'SCHEDULER_EVALUATION_NOT_LIVE');
      expect(withheld).toBeDefined();
      expect(direct).toBe(2);
    } finally {
      eventBus.unsubscribe('TRADE_IDEA_GENERATED', onIdea);
      eventBus.unsubscribe('DESK_NO_TRADE', onNoTrade);
    }
  });

  it('M1: still emits when isLiveCheck stays live through the point of emission', async () => {
    stubMarketData();
    const { tradingEngine } = await import('../engines/TradingEngine');
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';

    const received: any[] = [];
    const listener = (idea: any) => received.push(idea);
    eventBus.subscribe('TRADE_IDEA_GENERATED', listener);
    try {
      const agent = new QuantSignalAgent();
      const result = await agent.evaluateSymbol('QFIX', { emitIdeas: true, isLiveCheck: () => true });
      expect(result).not.toBeNull();
      const mine = received.find(i => i.symbol === 'QFIX' && i.agent === 'QuantEngine');
      expect(mine).toBeDefined();
      expect(mine.side).toBe('BUY');
    } finally {
      eventBus.unsubscribe('TRADE_IDEA_GENERATED', listener);
    }
  });

  it('withholds emission when the scheduler reports the evaluation not live (2026-10-11 timeliness invariant)', async () => {
    stubMarketData();
    const { tradingEngine } = await import('../engines/TradingEngine');
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';

    const ideas: any[] = [];
    const noTrades: any[] = [];
    const onIdea = (p: any) => ideas.push(p);
    const onNoTrade = (p: any) => noTrades.push(p);
    eventBus.subscribe('TRADE_IDEA_GENERATED', onIdea);
    eventBus.subscribe('DESK_NO_TRADE', onNoTrade);
    try {
      const agent = new QuantSignalAgent();
      // The fixture WOULD emit (strategy + EV + R:R satisfied, as proven by the test
      // above), but the scheduler reports this evaluation as no longer live — e.g.
      // the watchdog quarantined it while in flight. The idea must be withheld, not
      // emitted to ChiefTrader as if current.
      // A cooperative stage fence now aborts a superseded evaluation before it reaches emission, so the
      // result is null (QuantEvalSupersededError path); the invariant that matters is unchanged: no idea.
      const result = await agent.evaluateSymbol('QFIX', { emitIdeas: true, isLiveCheck: () => false });
      expect(result).toBeNull();
      expect(ideas.find(i => i.symbol === 'QFIX' && i.agent === 'QuantEngine')).toBeUndefined();
    } finally {
      eventBus.unsubscribe('TRADE_IDEA_GENERATED', onIdea);
      eventBus.unsubscribe('DESK_NO_TRADE', onNoTrade);
    }
  });
});
