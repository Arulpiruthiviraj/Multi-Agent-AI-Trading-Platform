/** Environment fault injection only: real scheduler, gateway, SQLite and Quant evaluation.
 * Default: accelerated three-hour scheduling chronology, NOT a wall-clock/resource certificate.
 * ARGUS_SCHEDULER_WALL_SOAK_MS optionally repeats real cycles for a measured wall-clock duration.
 * No strategy outputs, lifecycle authority, Chief/Risk decisions or fills are injected. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { quantScheduling } from '../config/quantScheduling';
import { tradingSafety } from '../config/tradingSafety';
import { registerHistoricalBarProvider } from '../engines/backtest/historicalBarProvider';
import { structuredLogger } from '../observability/StructuredLogger';
import { marketDataWorker } from '../services/MarketDataWorker';
import { QuantSignalAgent, quantSignalAgent } from '../services/QuantSignalAgent';
import { fastLaneManager } from '../fastlane/FastLaneManager';
import { evaluateFastCandidate, getFastLaneEvaluatorDiagnostics, resetFastLaneEvaluatorForTests } from '../fastlane/fastLaneEvaluator';
import { sqliteDb } from '../db';

const day = 86_400_000;
const originalDynamic = quantScheduling.dynamicSchedulingEnabled;
const wallDuration = Number(process.env.ARGUS_SCHEDULER_WALL_SOAK_MS ?? 0);
if (!Number.isSafeInteger(wallDuration) || wallDuration < 0) throw new Error('Invalid wall soak duration');
const fixtureEnd = Math.floor(Date.now() / day) * day - day;
const recentBar = { timestamp: fixtureEnd, open: 100, high: 100.1, low: 99.9, close: 100, volume: 2_000_000 };

function seed(symbol: string, stale = false) {
  const end = stale ? fixtureEnd - quantScheduling.dailyCacheTailRefreshGapMs - day : fixtureEnd;
  const insert = sqliteDb.prepare('INSERT OR REPLACE INTO ohlcv_bars (id,symbol,timeframe,timestamp,open,high,low,close,volume,source,provisional) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  sqliteDb.transaction(() => {
    for (let i = 0; i < 400; i++) {
      const ts = end - i * day;
      insert.run(`${symbol}:1Day:${ts}`, symbol, '1Day', ts, 100, 100.1, 99.9, 100, 2_000_000, 'CERTIFICATION_FIXTURE_ONLY', 0);
    }
  })();
}
beforeAll(() => {
  for (const symbol of ['SPY', 'QQQ', 'IWM']) seed(symbol);
});
afterAll(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  quantScheduling.dynamicSchedulingEnabled = originalDynamic;
  registerHistoricalBarProvider(null); resetFastLaneEvaluatorForTests();
});

it('three-hour chronology: late admissions refresh stale tails and start within the configured SLA', { timeout: Math.max(180_000, wallDuration + 180_000) }, async () => {
  quantScheduling.dynamicSchedulingEnabled = true;
  const agent = new QuantSignalAgent();
  let universe = ['SPY'];
  let clock = Date.now();
  const startClock = clock;
  let admittedAt = 0;
  let injected = false;
  let cycles = 0;
  let assessmentStarts = 0;
  const admissionLatencies: number[] = [];
  const bridge = (await import('../services/QuantCoreBridge')).quantCoreBridge;
  vi.spyOn(bridge, 'fetchCoreEnsembleDecision').mockResolvedValue(null);
  vi.spyOn(bridge, 'compareRegimeParity').mockResolvedValue(undefined);
  const realInfo = structuredLogger.info.bind(structuredLogger);
  const log = vi.spyOn(structuredLogger, 'info').mockImplementation((message, fields) => {
    realInfo(message, fields);
    if (message === 'quant_symbol_eval_started') {
      assessmentStarts++;
      if (!injected && fields?.symbol === 'SPY') {
        injected = true; admittedAt = Date.now(); universe = ['SPY', 'MRNA', 'CRCL'];
      }
      if (fields?.symbol === 'MRNA' || fields?.symbol === 'CRCL') {
        admissionLatencies.push(Date.now() - admittedAt);
      }
    }
  });
  vi.spyOn(marketDataWorker, 'getActiveSymbols').mockImplementation(() => [...universe]);
  vi.spyOn(marketDataWorker, 'getLatestPrice').mockReturnValue(100);
  vi.spyOn(marketDataWorker, 'getLatestPriceAgeMs').mockReturnValue(0);
  const fetchBars = vi.fn(async () => [recentBar]);
  registerHistoricalBarProvider({ id: 'ibkr_gateway', fetchBars });
  if (!wallDuration) vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const wallStarted = performance.now();
  const requiredCycles = Math.ceil(3 * 60 * 60_000 / tradingSafety.quantCycleIntervalMs);
  seed('MRNA', true); seed('CRCL', true);
  do {
    universe = ['SPY']; injected = false;
    const before = log.mock.calls.length;
    await agent.triggerNow();
    const events = log.mock.calls.slice(before);
    const starts = events.filter(([m]) => m === 'quant_cycle_started');
    const ends = events.filter(([m]) => m === 'quant_cycle_completed');
    expect(starts).toHaveLength(1); expect(ends).toHaveLength(1);
    expect(ends[0][1]?.cycleId).toBe(starts[0][1]?.cycleId);
    expect(ends[0][1]?.attemptedSymbols).toEqual(['SPY', 'MRNA', 'CRCL']);
    const terminal = events.filter(([m]) => m === 'quant_symbol_eval_finished');
    expect(terminal.map(([,f]) => f?.symbol)).toEqual(['SPY', 'MRNA', 'CRCL']);
    expect(terminal.every(([,f]) => f?.outcome === 'ASSESSED')).toBe(true);
    // Real assessment rows, not injected strategy outputs or synthetic BUY expectations.
    for (const symbol of ['MRNA', 'CRCL']) {
      expect(sqliteDb.prepare('SELECT count(*) n FROM quant_assessments WHERE symbol=?').get(symbol)).toMatchObject({ n: cycles + 1 });
    }
    cycles++;
    if (!wallDuration) clock += tradingSafety.quantCycleIntervalMs;
    else await new Promise<void>(resolve => setTimeout(resolve, tradingSafety.quantCycleIntervalMs));
  } while (wallDuration ? performance.now() - wallStarted < wallDuration : cycles < requiredCycles);
  expect(fetchBars).toHaveBeenCalled(); expect(assessmentStarts).toBe(cycles * 3);
  expect(admissionLatencies).toHaveLength(cycles * 2);
  expect(Math.max(...admissionLatencies)).toBeLessThanOrEqual(quantScheduling.admissionLatencyTargetMs);
  console.log(JSON.stringify({ label: 'NON_ORGANIC_CERTIFICATION_FIXTURE_ONLY', mode: wallDuration ? 'WALL_CLOCK' : 'ACCELERATED_CHRONOLOGY', cycles,
    representedDurationMs: clock - startClock, measuredWallDurationMs: performance.now() - wallStarted, admissionSlaMs: quantScheduling.admissionLatencyTargetMs }));
  vi.restoreAllMocks(); registerHistoricalBarProvider(null);
});

it('slow real provider outlives caller timeout without replacement fan-out or revived candidates', { timeout: 180_000 }, async () => {
  process.env.FAST_OPPORTUNITY_LANE_ENABLED = 'true';
  seed('LATE', true);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const fetchBars = vi.fn(async () => { await blocked; return [recentBar]; });
  registerHistoricalBarProvider({ id: 'ibkr_gateway', fetchBars });
  vi.spyOn(marketDataWorker, 'getLatestPrice').mockReturnValue(100);
  vi.spyOn(marketDataWorker, 'getLatestPriceAgeMs').mockReturnValue(0);
  // Only the external Java endpoint is unavailable; the real TS compatibility evaluation runs.
  const bridge = (await import('../services/QuantCoreBridge')).quantCoreBridge;
  vi.spyOn(bridge, 'fetchCoreEnsembleDecision').mockResolvedValue(null);
  vi.spyOn(bridge, 'compareRegimeParity').mockResolvedValue(undefined);
  const evaluation = vi.spyOn(quantSignalAgent, 'evaluateSymbol'); // call-through, never substituted
  const candidate = fastLaneManager.injectCandidate({ symbol: 'LATE', detectionSource: 'NEWS_CATALYST',
    liquidityEvidence: { dollarVolume: null, spreadBps: null, meetsMinLiquidity: false }, ttlMs: tradingSafety.fastLaneEvaluationTimeoutMs * 3 })!;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const response = evaluateFastCandidate(candidate.id);
  // Let the actual SQLite/cache/provider path reach the deliberately blocked boundary.
  for (let i = 0; i < 1000 && !fetchBars.mock.calls.length; i++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(fetchBars).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(tradingSafety.fastLaneEvaluationTimeoutMs);
  expect((await response).reasonCodes).toContain('EVALUATION_TIMEOUT');
  expect(getFastLaneEvaluatorDiagnostics().activeWorkCount).toBe(1);
  expect((await evaluateFastCandidate(candidate.id)).reasonCodes).toContain('SYMBOL_EVALUATION_STILL_RUNNING');
  expect(evaluation).toHaveBeenCalledTimes(1);
  vi.useRealTimers(); release();
  await evaluation.mock.results[0].value;
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(getFastLaneEvaluatorDiagnostics().activeWorkCount).toBe(0);
  expect(fastLaneManager.getCandidate(candidate.id)?.state).toBe('NO_SETUP');
  registerHistoricalBarProvider(null); vi.restoreAllMocks(); resetFastLaneEvaluatorForTests();
  delete process.env.FAST_OPPORTUNITY_LANE_ENABLED;
});
