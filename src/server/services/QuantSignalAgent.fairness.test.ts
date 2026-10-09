import { afterEach, expect, it, vi } from 'vitest';
import { QuantSignalAgent } from './QuantSignalAgent';
import { marketDataWorker } from './MarketDataWorker';
import * as provider from '../engines/backtest/historicalBarProvider';
import { structuredLogger } from '../observability/StructuredLogger';
import { quantScheduling } from '../config/quantScheduling';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { historicalDataGateway } from '../engines/backtest/HistoricalDataGateway';

const originalDynamic = quantScheduling.dynamicSchedulingEnabled;
const startedAgents: QuantSignalAgent[] = [];
afterEach(() => { for (const agent of startedAgents.splice(0)) agent.stop(); vi.restoreAllMocks(); quantScheduling.dynamicSchedulingEnabled = originalDynamic; });

it('first fresh admission wakes an idle worker, deduplicates ticks, and detaches on stop', async () => {
  quantScheduling.dynamicSchedulingEnabled = true;
  const agent = new QuantSignalAgent();
  startedAgents.push(agent);
  vi.spyOn(agent as any, 'isEnabled').mockReturnValue(true);
  const run = vi.spyOn(agent as any, 'runCycle').mockResolvedValue(undefined);
  const active = vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['SPY']);
  vi.spyOn(marketDataWorker, 'getLatestPrice').mockReturnValue(100);
  const age = vi.spyOn(marketDataWorker, 'getLatestPriceAgeMs').mockReturnValue(0);
  vi.spyOn(historicalDataGateway, 'getBarsRateLimitedUntilMs').mockReturnValue(0);
  agent.start();
  await Promise.resolve(); await Promise.resolve();
  expect(run).toHaveBeenCalledTimes(1);
  active.mockReturnValue(['SPY', 'MRNA']);
  age.mockReturnValue(Infinity);
  eventBus.emit(EVENTS.MARKET_DATA, { symbol: 'MRNA' });
  expect(run).toHaveBeenCalledTimes(1);
  age.mockReturnValue(0);
  eventBus.emit(EVENTS.MARKET_DATA, { symbol: 'MRNA' });
  eventBus.emit(EVENTS.MARKET_DATA, { symbol: 'MRNA' });
  expect(run).toHaveBeenCalledTimes(2);
  agent.stop();
  active.mockReturnValue(['SPY', 'MRNA', 'CRCL']);
  eventBus.emit(EVENTS.MARKET_DATA, { symbol: 'CRCL' });
  expect(run).toHaveBeenCalledTimes(2);
});

it('admission nudges respect canonical provider backoff without losing the pending symbol', async () => {
  quantScheduling.dynamicSchedulingEnabled = true;
  const agent = new QuantSignalAgent();
  startedAgents.push(agent);
  vi.spyOn(agent as any, 'isEnabled').mockReturnValue(true);
  const run = vi.spyOn(agent as any, 'runCycle').mockResolvedValue(undefined);
  const active = vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['SPY']);
  vi.spyOn(marketDataWorker, 'getLatestPrice').mockReturnValue(100);
  vi.spyOn(marketDataWorker, 'getLatestPriceAgeMs').mockReturnValue(0);
  vi.spyOn(historicalDataGateway, 'getBarsRateLimitedUntilMs').mockReturnValue(Date.now() + 60_000);
  agent.start();
  await Promise.resolve(); await Promise.resolve();
  active.mockReturnValue(['SPY', 'MRNA']);
  eventBus.emit(EVENTS.MARKET_DATA, { symbol: 'MRNA' });
  expect(run).toHaveBeenCalledTimes(1);
  expect(agent.getSchedulingStatus().pendingAdmissions).toEqual(['MRNA']);
});

it('opt-in scheduling assesses late admissions at the next worker boundary without extra concurrency', async () => {
  quantScheduling.dynamicSchedulingEnabled = true;
  const agent = new QuantSignalAgent();
  vi.spyOn(agent as any, 'symbolConcurrency').mockReturnValue(1);
  let active = ['SPY', 'QQQ'];
  vi.spyOn(marketDataWorker, 'getActiveSymbols').mockImplementation(() => active);
  let inFlight = 0;
  let peak = 0;
  const evaluate = vi.spyOn(agent, 'evaluateSymbol').mockImplementation(async symbol => {
    peak = Math.max(peak, ++inFlight);
    if (symbol === 'SPY') active = ['SPY', 'QQQ', 'MRNA'];
    await Promise.resolve();
    inFlight--;
    return null;
  });
  await agent.triggerNow();
  expect(evaluate.mock.calls.map(c => c[0])).toEqual(['SPY', 'MRNA', 'QQQ']);
  expect(peak).toBe(1);
});

it('stop retains the in-flight evaluation but prevents the stopped generation claiming another symbol', async () => {
  quantScheduling.dynamicSchedulingEnabled = true;
  const agent = new QuantSignalAgent();
  vi.spyOn(agent as any, 'symbolConcurrency').mockReturnValue(1);
  vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['SPY', 'QQQ']);
  let release!: () => void;
  const pending = new Promise<null>(resolve => { release = () => resolve(null); });
  const evaluate = vi.spyOn(agent, 'evaluateSymbol').mockReturnValue(pending);
  const run = agent.triggerNow();
  expect(evaluate).toHaveBeenCalledTimes(1);
  agent.stop();
  release();
  await run;
  expect(evaluate.mock.calls.map(c => c[0])).toEqual(['SPY']);
  expect(agent.getSchedulingStatus().nextCycleSymbol).toBe(null);
});

it('cooperatively ends a budgeted cycle and rotates to its unattempted tail', async () => {
  quantScheduling.dynamicSchedulingEnabled = true;
  const agent = new QuantSignalAgent();
  vi.spyOn(agent as any, 'symbolConcurrency').mockReturnValue(1);
  vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['SPY', 'QQQ']);
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const evaluate = vi.spyOn(agent, 'evaluateSymbol').mockImplementation(async () => {
    now += quantScheduling.maxCycleDurationMs;
    return null;
  });
  await agent.triggerNow();
  await agent.triggerNow();
  expect(evaluate.mock.calls.map(c => c[0])).toEqual(['SPY', 'QQQ']);
});

// Scheduling test only. Evaluation is deliberately stubbed; no strategy/consensus/fill claim.
it('resumes unattempted symbols after provider backoff instead of starving the tail every cycle', async () => {
  const agent = new QuantSignalAgent();
  vi.spyOn(agent as any, 'symbolConcurrency').mockReturnValue(1);
  vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['SPY', 'QQQ', 'OKTA']);
  vi.spyOn(provider, 'getRegisteredHistoricalBarProvider').mockReturnValue(null);
  const evaluate = vi.spyOn(agent, 'evaluateSymbol').mockRejectedValue(new Error('429 rate-limited'));
  const log = vi.spyOn(structuredLogger, 'info');
  await agent.triggerNow();
  await agent.triggerNow();
  await agent.triggerNow();
  expect(evaluate.mock.calls.map(call => call[0])).toEqual(['SPY', 'QQQ', 'OKTA']);
  expect(log).toHaveBeenCalledWith('quant_cycle_completed', expect.objectContaining({
    attemptedSymbols: ['SPY'], notAttemptedSymbols: ['QQQ', 'OKTA'], reason: 'PROVIDER_BACKOFF',
  }));
});

it('handles removal of the saved resume symbol without losing the current universe', async () => {
  const agent = new QuantSignalAgent();
  vi.spyOn(agent as any, 'symbolConcurrency').mockReturnValue(1);
  const active = vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['SPY', 'QQQ']);
  vi.spyOn(provider, 'getRegisteredHistoricalBarProvider').mockReturnValue(null);
  const evaluate = vi.spyOn(agent, 'evaluateSymbol').mockRejectedValueOnce(new Error('429')).mockResolvedValue(null);
  await agent.triggerNow();
  active.mockReturnValue(['OKTA', 'AAPL']);
  await agent.triggerNow();
  expect(evaluate.mock.calls.map(call => call[0])).toEqual(['SPY', 'AAPL', 'OKTA']);
});

it('journals the scheduled snapshot and finishes failed/null attempts under the same cycle id', async () => {
  const agent = new QuantSignalAgent();
  vi.spyOn(agent as any, 'symbolConcurrency').mockReturnValue(1);
  vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(['MRNA', 'CRCL']);
  vi.spyOn(provider, 'getRegisteredHistoricalBarProvider').mockReturnValue(null);
  vi.spyOn(agent, 'evaluateSymbol').mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('provider unavailable'));
  const log = vi.spyOn(structuredLogger, 'info');
  await agent.triggerNow();
  const started = log.mock.calls.find(([message]) => message === 'quant_cycle_started')![1]!;
  expect(started).toMatchObject({ scheduledSymbols: ['MRNA', 'CRCL'], providerId: null });
  const finished = log.mock.calls.filter(([message]) => message === 'quant_symbol_evaluation_finished').map(([, fields]) => fields);
  expect(finished).toEqual([
    expect.objectContaining({ cycleId: started.cycleId, symbol: 'MRNA', outcome: 'NO_ASSESSMENT', durationMs: expect.any(Number) }),
    expect.objectContaining({ cycleId: started.cycleId, symbol: 'CRCL', outcome: 'ERROR', durationMs: expect.any(Number) }),
  ]);
});
