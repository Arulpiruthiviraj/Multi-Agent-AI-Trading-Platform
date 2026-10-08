import { describe, it, expect, vi } from 'vitest';

// Heavy module graph (HistoricalDataGateway, strategiesEngine registry) is mocked out - this
// suite only exercises the tick() single-flight wrapper, never the evaluation itself.
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

/**
 * DEF-8 regression: StrategyEngineShadowRunner.tick() (300s interval) was scheduled bare -
 * an interval tick firing while the previous tick's 400-day bar fetch + signal inserts were
 * still in flight produced overlapping concurrent ticks. With no uniqueness constraint on
 * (strategyId, symbol, timestamp) in strategy_engine_signals, two overlapping ticks
 * evaluating the same snapshot could double-insert the same signal. The single-flight guard
 * coalesces the second tick instead of queueing it; tick() re-reads settings fresh every
 * cycle, so a skipped tick loses nothing.
 */
describe('StrategyEngineShadowRunner.tick single-flight (DEF-8)', () => {
  it('coalesces overlapping ticks: the cycle runs once, the second tick resolves as a no-op', async () => {
    const runner = new StrategyEngineShadowRunner() as any;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let cycles = 0;
    runner.tickCycle = async () => {
      cycles++;
      await gate;
      return { ran: true, signalsRecorded: 7 };
    };

    const p1 = runner.tick();
    const p2 = runner.tick();
    // Give p1 a chance to enter the guarded cycle before releasing it.
    await new Promise((r) => setTimeout(r, 10));
    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(cycles).toBe(1);
    expect(r1).toEqual({ ran: true, signalsRecorded: 7 });
    // Coalesced tick resolves honestly as "did not run" (same shape as feature-off no-op).
    expect(r2).toEqual({ ran: false, signalsRecorded: 0 });
    expect(runner.tickGuard.getMetrics().totalSkippedInFlight).toBeGreaterThanOrEqual(1);
  });

  it('a throwing cycle is logged and swallowed by the guard - tick() still resolves', async () => {
    const runner = new StrategyEngineShadowRunner() as any;
    runner.tickCycle = async () => {
      throw new Error('boom');
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runner.tick();
      expect(result).toEqual({ ran: false, signalsRecorded: 0 });
      expect(runner.tickGuard.getMetrics().totalErrors).toBeGreaterThanOrEqual(1);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
