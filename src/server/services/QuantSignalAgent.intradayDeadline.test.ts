import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * 2026-10-12 live forensic regression: with QUANT_ORB_STRATEGY_ENABLED the intraday (1Min) ensureBars
 * is awaited by every evaluation. Live, its cache coverage never met the sufficiency bar, so every
 * evaluation queued behind the global paced provider path (~300 s). The wait is now bounded.
 */
vi.mock('../core/dataQuality', () => ({
  assessDataQuality: () => ({ overall: 'GREEN', tradeBlocked: false, blockReason: null, channels: [] }),
}));
vi.mock('../ai/AIRouter', () => ({
  AIRouter: { getInstance: () => ({
    routeTask: async () => { throw new Error('No AI provider configured in this test.'); },
    routeConsensus: async () => null,
    hasAnyRoutableProvider: async () => true,
  }) },
}));

describe('QuantSignalAgent intraday fetch deadline', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let QuantSignalAgent: any;
  let historicalDataGateway: any;
  let tradingSafety: any;
  let marketDataWorker: any;
  const originalOrb = process.env.QUANT_ORB_STRATEGY_ENABLED;
  const originalWait = { v: 0 };

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_quant_intraday_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.ALPACA_API_KEY = process.env.ALPACA_API_KEY || 'test-key';
    process.env.ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY || 'test-secret';
    process.env.QUANT_ORB_STRATEGY_ENABLED = 'true';
    ({ sqliteDb } = await import('../db'));
    ({ historicalDataGateway } = await import('../engines/backtest/HistoricalDataGateway'));
    ({ tradingSafety } = await import('../config/tradingSafety'));
    ({ marketDataWorker } = await import('./MarketDataWorker'));
    ({ QuantSignalAgent } = await import('./QuantSignalAgent'));
    originalWait.v = tradingSafety.quantIntradayFetchMaxWaitMs;
  });

  afterAll(() => {
    if (originalOrb === undefined) delete process.env.QUANT_ORB_STRATEGY_ENABLED; else process.env.QUANT_ORB_STRATEGY_ENABLED = originalOrb;
    tradingSafety.quantIntradayFetchMaxWaitMs = originalWait.v;
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
  });

  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  function seedDaily(symbol: string) {
    const now = Date.now();
    const ins = sqliteDb.prepare('INSERT OR REPLACE INTO ohlcv_bars (id, symbol, timeframe, timestamp, open, high, low, close, volume, source, provisional) VALUES (?,?,?,?,?,?,?,?,?,?,0)');
    for (let i = 0; i < 90; i++) {
      const ts = now - (90 - i) * 86_400_000;
      const c = 100 + i * 0.1;
      ins.run(`${symbol}:1Day:${ts}`, symbol, '1Day', ts, c, c * 1.005, c * 0.995, c, 1_000_000, 'alpaca');
    }
  }

  it('does not stall the evaluation on a never-settling intraday ensureBars, and keeps the underlying fetch running', async () => {
    seedDaily('QINTRA');
    // 11:00 ET on a Monday: the intraday window exists regardless of when the suite runs.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-12T15:00:00Z') });
    tradingSafety.quantIntradayFetchMaxWaitMs = 50;
    vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['QINTRA']);
    const realEnsure = historicalDataGateway.ensureBars.bind(historicalDataGateway);
    let intradayCalls = 0;
    let intradayStillPending = true;
    vi.spyOn(historicalDataGateway, 'ensureBars').mockImplementation((async (symbol: string, tf: string, s: number, e: number) => {
      if (tf === '1Min') {
        intradayCalls++;
        return new Promise<void>(() => { /* never settles: stalled provider queue */ });
      }
      return realEnsure(symbol, tf, s, e);
    }) as any);

    const started = Date.now();
    const evaluation = await new QuantSignalAgent().evaluateSymbol('QINTRA', { emitIdeas: false });
    void started;
    expect(intradayCalls).toBe(1); // the fetch was attempted exactly once - not duplicated, not cancelled
    expect(intradayStillPending).toBe(true);
    expect(evaluation).not.toBeNull(); // evaluation completed without intraday bars (fail-open path)
  }, 20_000);
});
