import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('runBacktest - real backtest against locally seeded bars', () => {
  let tmpDbPath: string;
  let db: any;
  let schema: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_runbacktest_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;
    ({ db } = await import('../../db'));
    schema = await import('../../db/schema');
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;

    // Real, oscillating bars (real up/down cycle) so a trend-following strategy has real entries
    // and exits to compute against - not a monotonic series that never triggers a stop/exit.
    let price = 100;
    const now = Date.now();
    for (let i = 0; i < 300; i++) {
      const cyclePos = i % 40;
      price += cyclePos < 20 ? 0.8 : -0.9;
      const ts = now - (300 - i) * 24 * 60 * 60 * 1000;
      await db.insert(schema.ohlcvBars).values({
        id: `TEST:1Day:${ts}`, symbol: 'TEST', timeframe: '1Day', timestamp: ts,
        open: price, high: price + 1, low: price - 1, close: price, volume: 1_000_000, source: 'test-fixture',
      }).run();
    }
  });

  afterAll(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('produces a real, non-fabricated StrategyPerformance record from real seeded bars', async () => {
    const { runBacktest } = await import('./runBacktest');
    const { createStrategy } = await import('../core/createStrategy');
    const { leaf } = await import('../conditions/ConditionTypes');

    const strategy = createStrategy({
      name: 'Test Backtest Strategy', family: 'TREND', implementationStatus: 'REAL', requiredIndicators: ['rsi14'],
      entryConditions: leaf('RSIBelow', { value: 40 }),
      confirmationConditions: null, invalidationConditions: null,
      exitConditions: leaf('RSIAbove', { value: 60 }),
      stopLoss: { kind: 'ATR_MULTIPLE', value: 2, basis: 'test' },
      takeProfit: null,
      positionSizing: { kind: 'FIXED_FRACTIONAL', value: 0.01, basis: 'test' },
      parameters: [], parameterValues: {}, dependencies: [],
      metadata: { description: 'test', tags: [], assetClasses: ['EQUITY'], timeframes: ['1d'], marketRegimes: ['TRENDING_UP'], origin: 'BASE' },
    });

    const now = Date.now();
    const result = await runBacktest({ strategy, symbol: 'TEST', timeframe: '1d', startMs: now - 300 * 86_400_000, endMs: now });

    expect(result.barsUsed).toBeGreaterThan(0);
    expect(result.performance.source).toBe('BACKTEST');
    expect(result.performance.strategyId).toBe(strategy.id);
    expect(result.performance.totalTrades).toBeGreaterThanOrEqual(0);
    expect(result.datasetHash).toMatch(/^[0-9a-f]{64}$/);
    // If any trades happened, verify the numbers are internally consistent (real math, not fabricated).
    if (result.performance.totalTrades > 0) {
      expect(result.performance.winningTrades + result.performance.losingTrades).toBe(result.performance.totalTrades);
      expect(result.performance.netProfit).toBeCloseTo(result.performance.grossProfit - result.performance.grossLoss, 2);
    }
  });

  it('is reproducible - same inputs produce the same datasetHash', async () => {
    const { runBacktest } = await import('./runBacktest');
    const { createStrategy } = await import('../core/createStrategy');
    const { leaf } = await import('../conditions/ConditionTypes');
    const strategy = createStrategy({
      name: 'Repro Test', family: 'TREND', implementationStatus: 'REAL', requiredIndicators: [],
      entryConditions: leaf('Never'), confirmationConditions: null, invalidationConditions: null, exitConditions: null,
      stopLoss: { kind: 'ATR_MULTIPLE', value: 2, basis: 'test' }, takeProfit: null,
      positionSizing: { kind: 'FIXED_FRACTIONAL', value: 0.01, basis: 'test' },
      parameters: [], parameterValues: {}, dependencies: [],
      metadata: { description: 'test', tags: [], assetClasses: ['EQUITY'], timeframes: ['1d'], marketRegimes: ['TRENDING_UP'], origin: 'BASE' },
    });
    const now = Date.now();
    const a = await runBacktest({ strategy, symbol: 'TEST', timeframe: '1d', startMs: now - 300 * 86_400_000, endMs: now });
    const b = await runBacktest({ strategy, symbol: 'TEST', timeframe: '1d', startMs: now - 300 * 86_400_000, endMs: now });
    expect(a.datasetHash).toBe(b.datasetHash);
    expect(a.performance.totalTrades).toBe(0); // 'Never' entry condition - real zero trades, not fabricated
  });

  it('throws (never fabricates) when there is not enough real history', async () => {
    const { runBacktest } = await import('./runBacktest');
    const { createStrategy } = await import('../core/createStrategy');
    const { leaf } = await import('../conditions/ConditionTypes');
    const strategy = createStrategy({
      name: 'Too Little Data', family: 'TREND', implementationStatus: 'REAL', requiredIndicators: [],
      entryConditions: leaf('Always'), confirmationConditions: null, invalidationConditions: null, exitConditions: null,
      stopLoss: { kind: 'ATR_MULTIPLE', value: 2, basis: 'test' }, takeProfit: null,
      positionSizing: { kind: 'FIXED_FRACTIONAL', value: 0.01, basis: 'test' },
      parameters: [], parameterValues: {}, dependencies: [],
      metadata: { description: 'test', tags: [], assetClasses: ['EQUITY'], timeframes: ['1d'], marketRegimes: ['TRENDING_UP'], origin: 'BASE' },
    });
    await expect(runBacktest({
      strategy, symbol: 'NOSUCHSYMBOL', timeframe: '1d', startMs: Date.now() - 5 * 86_400_000, endMs: Date.now(),
    })).rejects.toThrow(/not enough real history|Only \d+ real bars/);
  });
});
