import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Same mock surface as StrategyEngineShadowRunner.singleFlight.test.ts - this suite only
// exercises the start/stop lifecycle, never the evaluation itself.
vi.mock('../db', () => ({
  db: {
    select: () => ({ from: () => ({ limit: () => Promise.resolve([]) }) }),
    insert: () => ({ values: () => Promise.resolve({}) }),
  },
}));
vi.mock('../db/schema', () => ({ settings: {}, strategyEngineSignals: {} }));
vi.mock('../engines/backtest/HistoricalDataGateway', () => ({
  historicalDataGateway: { getBars: async () => [] },
}));
vi.mock('../strategiesEngine/core/MarketSnapshot', () => ({
  buildMarketSnapshotFromBars: () => ({}),
}));
vi.mock('../strategiesEngine/conditions/evaluateCondition', () => ({
  evaluateCondition: () => false,
}));
vi.mock('../strategiesEngine/index', () => ({
  defaultRegistry: { get: () => undefined },
}));
vi.mock('../core/EventBus', () => ({ eventBus: { on: vi.fn(), emit: vi.fn(), publish: vi.fn() } }));

import { StrategyEngineShadowRunner } from './StrategyEngineShadowRunner';
import { runtimeIntervals } from '../config/runtimeIntervals';

/**
 * Lifecycle verification (TIMERS/SCHEDULERS hunt, 2026-10-08): the prior fix gave
 * StrategyEngineShadowRunner a guarded start() and a stoppable interval. This suite proves
 * the lifecycle directly on a fresh instance - one interval across double-starts, zero
 * timers after stop(), no tick fired while stopped, and a clean restart.
 */
describe('StrategyEngineShadowRunner start/stop lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('double-start creates exactly one interval; stop() clears it and is idempotent', () => {
    const runner = new StrategyEngineShadowRunner() as any;
    expect(vi.getTimerCount()).toBe(0);
    runner.start();
    runner.start();
    expect(runner.intervalId).not.toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    runner.stop();
    expect(runner.intervalId).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => runner.stop()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('no tick fires after stop(); restart resumes exactly one interval', async () => {
    const runner = new StrategyEngineShadowRunner();
    const tickSpy = vi.spyOn(runner, 'tick');
    runner.start();
    await vi.advanceTimersByTimeAsync(runtimeIntervals.strategyEngineShadowMs * 2 + 1000);
    const ticksWhileRunning = tickSpy.mock.calls.length;
    expect(ticksWhileRunning).toBeGreaterThanOrEqual(2);

    runner.stop();
    await vi.advanceTimersByTimeAsync(runtimeIntervals.strategyEngineShadowMs * 3);
    expect(tickSpy.mock.calls.length).toBe(ticksWhileRunning); // nothing fired while stopped

    runner.start();
    runner.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(runtimeIntervals.strategyEngineShadowMs + 1000);
    expect(tickSpy.mock.calls.length).toBeGreaterThan(ticksWhileRunning);
    runner.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
