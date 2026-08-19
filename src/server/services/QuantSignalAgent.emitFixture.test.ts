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

  it('emits QuantEngine TRADE_IDEA_GENERATED when the fixture clears EV and R:R', async () => {
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
});
