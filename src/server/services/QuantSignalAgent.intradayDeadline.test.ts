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
  let structuredLogger: any;
  const originalOrb = process.env.QUANT_ORB_STRATEGY_ENABLED;
  const originalWait = { v: 0 };

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_quant_intraday_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.ALPACA_API_KEY = process.env.ALPACA_API_KEY || 'test-key';
    process.env.ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY || 'test-secret';
    process.env.QUANT_ORB_STRATEGY_ENABLED = 'true';
    process.env.QUANT_VWAP_REVERSION_ENABLED = 'true';
    process.env.QUANT_VWAP_STRUCTURE_ENABLED = 'true';
    ({ sqliteDb } = await import('../db'));
    ({ historicalDataGateway } = await import('../engines/backtest/HistoricalDataGateway'));
    ({ tradingSafety } = await import('../config/tradingSafety'));
    ({ marketDataWorker } = await import('./MarketDataWorker'));
    ({ structuredLogger } = await import('../observability/StructuredLogger'));
    ({ QuantSignalAgent } = await import('./QuantSignalAgent'));
    originalWait.v = tradingSafety.quantIntradayFetchMaxWaitMs;
  });

  afterAll(() => {
    if (originalOrb === undefined) delete process.env.QUANT_ORB_STRATEGY_ENABLED; else process.env.QUANT_ORB_STRATEGY_ENABLED = originalOrb;
    delete process.env.QUANT_VWAP_REVERSION_ENABLED; delete process.env.QUANT_VWAP_STRUCTURE_ENABLED;
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
    let capturedIntent: any = null;
    vi.spyOn(historicalDataGateway, 'ensureBars').mockImplementation((async (symbol: string, tf: string, s: number, e: number) => {
      if (tf === '1Min') {
        intradayCalls++;
        capturedIntent = (await import('../data/historicalRequestIntent')).currentHistoricalIntent();
        return new Promise<void>(() => { /* never settles: stalled provider queue */ });
      }
      return realEnsure(symbol, tf, s, e);
    }) as any);

    const logSpy = vi.spyOn(structuredLogger, 'info');
    const started = Date.now();
    const evaluation = await new QuantSignalAgent().evaluateSymbol('QINTRA', { emitIdeas: false });
    void started;
    expect(intradayCalls).toBe(1); // the fetch was attempted exactly once - not duplicated
    // 2026-10-13: it carries a live-Quant intent and an abandonment signal that fired at the decision deadline, so the scheduler
    // discards / cancels the IBKR request instead of leaving it as zombie work.
    expect(capturedIntent?.intent).toBe('QUANT_ON_DEMAND');
    expect(capturedIntent?.signal?.aborted).toBe(true);
    expect(intradayStillPending).toBe(true);
    expect(evaluation).not.toBeNull(); // evaluation completed without intraday bars (fail-open path)

    const deadlineAvailability = logSpy.mock.calls.find((call: any[]) =>
      call[0] === 'quant_bar_input_availability'
      && call[1]?.timeframe === '1Min'
      && call[1]?.outcome === 'DEADLINE');
    expect(deadlineAvailability).toBeDefined();
    const deadlinePayload = deadlineAvailability?.[1] as any;
    expect(deadlinePayload?.terminalReason).toBe('INTRADAY_FETCH_DEADLINE');
    expect(deadlinePayload?.barCount).toBe(0);
  }, 20_000);

  it('records FETCH_ERROR distinctly from NO_SETUP when the 1Min provider fails', async () => {
    seedDaily('QINTRAERR');
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-12T15:00:00Z') });
    vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['QINTRAERR']);
    const realEnsure = historicalDataGateway.ensureBars.bind(historicalDataGateway);
    vi.spyOn(historicalDataGateway, 'ensureBars').mockImplementation((async (symbol: string, tf: string, s: number, e: number) => {
      if (tf === '1Min') throw new Error('synthetic provider unavailable');
      return realEnsure(symbol, tf, s, e);
    }) as any);
    const logSpy = vi.spyOn(structuredLogger, 'info');

    const evaluation = await new QuantSignalAgent().evaluateSymbol('QINTRAERR', { emitIdeas: false });
    expect(evaluation).not.toBeNull();

    const failedAvailability = logSpy.mock.calls.find((call: any[]) =>
      call[0] === 'quant_bar_input_availability'
      && call[1]?.timeframe === '1Min'
      && call[1]?.outcome === 'FETCH_ERROR');
    expect(failedAvailability).toBeDefined();
    const failedPayload = failedAvailability?.[1] as any;
    expect(failedPayload?.terminalReason).toBeTruthy();
    expect(failedPayload?.error).toMatch(/synthetic provider unavailable/);
  }, 20_000);
  it('records evaluation origin, queue age and intraday outcome distinctly for scheduled vs on-demand evaluations', async () => {
    seedDaily('QORIG');
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-12T15:00:00Z') });
    tradingSafety.quantIntradayFetchMaxWaitMs = 50;
    vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['QORIG']);
    const realEnsure = historicalDataGateway.ensureBars.bind(historicalDataGateway);
    vi.spyOn(historicalDataGateway, 'ensureBars').mockImplementation((async (symbol: string, tf: string, s: number, e: number) => {
      if (tf === '1Min') return new Promise<void>(() => { /* stalled */ });
      return realEnsure(symbol, tf, s, e);
    }) as any);
    const logSpy = vi.spyOn(structuredLogger, 'info');
    const agent = new QuantSignalAgent();
    const t0 = Date.now();
    await agent.evaluateSymbol('QORIG', { emitIdeas: false, cycleCtx: { cycleId: 'cyc-1', scheduledIndex: 3, scheduledAtMs: t0 - 5_000 } });
    await agent.evaluateSymbol('QORIG', { emitIdeas: false, origin: 'ON_DEMAND_CONFLUENCE', triggerId: 'trig-9', requestedAtMs: t0 - 700 });
    await agent.evaluateSymbol('QORIG', { emitIdeas: false });

    const finished = logSpy.mock.calls.filter((c: any[]) => c[0] === 'quant_symbol_eval_finished').map((c: any[]) => c[1] as any);
    expect(finished).toHaveLength(3);
    const [sched, confluence, unspecified] = finished;
    expect(sched).toMatchObject({ evaluationOrigin: 'SCHEDULED_CYCLE', scheduledCycleId: 'cyc-1', onDemandTriggerId: null, queueAgeMs: 5_000, intradayOutcome: 'DEADLINE', terminalOutcome: 'ASSESSED' });
    expect(confluence).toMatchObject({ evaluationOrigin: 'ON_DEMAND_CONFLUENCE', scheduledCycleId: null, onDemandTriggerId: 'trig-9', queueAgeMs: 700 });
    // no requestedAtMs supplied -> null with an explicit reason, never fabricated
    expect(unspecified).toMatchObject({ evaluationOrigin: 'ON_DEMAND_UNSPECIFIED', queueAgeMs: null, completionAgeMs: null });
    const started = logSpy.mock.calls.filter((c: any[]) => c[0] === 'quant_symbol_eval_started').map((c: any[]) => c[1] as any);
    expect(started[2].ageMeasurementNote).toMatch(/not estimated/);
    for (const f of finished) {
      expect(f.dailyBarsAgeMs).toEqual(expect.any(Number));
      expect(f.intradayBarsAgeMs).toBeNull(); // DEADLINE: no intraday bars -> null, not invented
      expect(f).toHaveProperty('candidateAgeAtStartMs');
      expect(f).toHaveProperty('candidateAgeAtFinishMs');
    }
  }, 30_000);

  it('AVAILABLE 1Min bars are actually passed into the intraday strategies (ORB/VWAP are evaluable, not data-missing)', async () => {
    seedDaily('QAVAIL');
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-12T15:00:00Z') });
    vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['QAVAIL']);
    // real 1Min session bars 09:30-11:00 ET (13:30Z-15:00Z) with a clear opening range then a breakout
    const ins = sqliteDb.prepare('INSERT OR REPLACE INTO ohlcv_bars (id, symbol, timeframe, timestamp, open, high, low, close, volume, source, provisional) VALUES (?,?,?,?,?,?,?,?,?,?,0)');
    const open = Date.parse('2026-10-12T13:30:00Z');
    for (let i = 0; i < 90; i++) {
      const ts = open + i * 60_000;
      const base = i < 30 ? 100 + (i % 3) * 0.05 : 100.2 + (i - 30) * 0.05;
      ins.run(`QAVAIL:1Min:${ts}`, 'QAVAIL', '1Min', ts, base, base + 0.1, base - 0.1, base + 0.02, 50_000 + i * 100, 'ibkr');
    }
    const realEnsure = historicalDataGateway.ensureBars.bind(historicalDataGateway);
    vi.spyOn(historicalDataGateway, 'ensureBars').mockImplementation((async (symbol: string, tf: string, s: number, e: number) => {
      if (tf === '1Min') return; // bars already present (as after a successful provider fetch)
      return realEnsure(symbol, tf, s, e);
    }) as any);
    const logSpy = vi.spyOn(structuredLogger, 'info');
    const evaluation = await new QuantSignalAgent().evaluateSymbol('QAVAIL', { emitIdeas: false });
    expect(evaluation).not.toBeNull();
    const avail = logSpy.mock.calls.find((c: any[]) => c[0] === 'quant_bar_input_availability' && c[1]?.timeframe === '1Min');
    expect((avail?.[1] as any)?.outcome).toBe('AVAILABLE');
    const orb = evaluation!.strategyEvaluations.find((e: any) => e.strategy === 'OPENING_RANGE_BREAKOUT') as any;
    expect(orb).toBeDefined();
    const orbText = JSON.stringify([orb.conditionsFailed, orb.contradictions]);
    expect(orbText).not.toMatch(/daily-granularity|No opening range/i);
    for (const id of ['VWAP_MEAN_REVERSION', 'VWAP_VOLUME_STRUCTURE']) {
      const v = evaluation!.strategyEvaluations.find((e: any) => e.strategy === id) as any;
      expect(v, id).toBeDefined();
      expect(JSON.stringify([v.conditionsFailed, v.contradictions]), id).not.toMatch(/daily-granularity|intraday bars|unavailable/i);
    }
    const finished = logSpy.mock.calls.filter((c: any[]) => c[0] === 'quant_symbol_eval_finished').map((c: any[]) => c[1] as any).pop();
    expect(finished.intradayOutcome).toBe('AVAILABLE');
    expect(finished.intradayBarsAgeMs).toEqual(expect.any(Number));
  }, 30_000);
});
