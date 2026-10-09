import { afterEach, expect, it, vi } from 'vitest';
import { QuantSignalAgent } from './QuantSignalAgent';
import { marketDataWorker } from './MarketDataWorker';
import * as provider from '../engines/backtest/historicalBarProvider';
import { structuredLogger } from '../observability/StructuredLogger';

afterEach(() => vi.restoreAllMocks());

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
