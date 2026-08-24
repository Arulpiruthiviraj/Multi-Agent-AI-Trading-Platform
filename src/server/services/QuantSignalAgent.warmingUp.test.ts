import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Real defect fixed this pass: computeLiveStrategyWinRate() only ever returned null for exactly
 * zero closed trades - a strategy with e.g. 3 closed trades (100% win rate from pure noise) was
 * treated as a fully statistically-trusted EV estimate, with no MIN_SAMPLE_SIZE_FOR_KELLY-equivalent
 * gate applied (despite QuantSignalAgent.ts's own prior comment claiming one existed). This proves
 * a tiny, noisy sample is now treated the same as COLD_START (falls through to the same
 * operator-gated bootstrap-or-refuse path) rather than fabricating a "real edge" from 3 trades.
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

// This repo's real .env has QUANT_COLD_START_BOOTSTRAP_ENABLED=true (an operator has opted in on
// this machine) - process.env deletion alone is not reliable here since isRuntimeFlagEnabled()
// resolves through effectiveRuntimeConfig's own runtime-settings layer, not a raw process.env read.
// Mock the flag directly so this test proves the sample-size gate itself, independent of whatever
// this environment's real operator-set flag happens to be.
vi.mock('../config/tradingSafety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/tradingSafety')>();
  return { ...actual, isQuantColdStartBootstrapEnabled: () => false };
});

vi.mock('../quant/risk/LiveStrategyPerformance', () => ({
  // A "perfect" but tiny sample - exactly the kind of noise a real sample-size gate must refuse.
  computeLiveStrategyWinRate: async () => ({
    strategyId: 'MOMENTUM_BREAKOUT',
    sampleSize: 3,
    wins: 3,
    losses: 0,
    winProbability: 1.0,
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

describe('QuantSignalAgent WARMING_UP sample-size gate', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let eventBus: any;
  let marketDataWorker: any;
  let QuantSignalAgent: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_quant_warmingup_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.ALPACA_API_KEY = process.env.ALPACA_API_KEY || 'test-key';
    process.env.ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY || 'test-secret';
    delete process.env.QUANT_COLD_START_BOOTSTRAP_ENABLED; // explicit default-off for this test
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

  it('does not emit a live trade idea backed by a 3-trade "100% win rate" - too few samples to trust, same as cold-start', async () => {
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
    vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['QWARM']);
    vi.spyOn(marketDataWorker, 'getLatestPriceAgeMs').mockReturnValue(1000);

    const received: any[] = [];
    const listener = (idea: any) => received.push(idea);
    eventBus.subscribe('TRADE_IDEA_GENERATED', listener);

    const { tradingEngine } = await import('../engines/TradingEngine');
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';

    const agent = new QuantSignalAgent();
    const result = await agent.evaluateSymbol('QWARM');
    eventBus.unsubscribe('TRADE_IDEA_GENERATED', listener);

    expect(result).not.toBeNull();
    const mine = received.find((i) => i.symbol === 'QWARM' && i.agent === 'QuantEngine');
    // Bootstrap is off by default in this test, so a WARMING_UP strategy must produce no idea at
    // all - never a "validated" idea fabricated from a 3-trade sample.
    expect(mine).toBeUndefined();
  });

  // The bootstrap-enabled emission path itself (WARMING_UP now takes the exact same branch as the
  // pre-existing COLD_START case) is already covered by QuantSignalAgent.test.ts's own
  // "emits a cold-start regime-only bootstrap idea only when QUANT_COLD_START_BOOTSTRAP_ENABLED=true"
  // test - not duplicated here.
});
