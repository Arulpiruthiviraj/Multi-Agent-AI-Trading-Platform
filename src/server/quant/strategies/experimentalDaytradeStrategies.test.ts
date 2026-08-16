import { describe, it, expect } from 'vitest';
import { baseFixture } from './testHelpers';
import { vwapVolumeStructure } from './vwapVolumeStructure';
import { openingRangeBreakout } from './openingRangeBreakout';
import { vwapMeanReversion } from './vwapMeanReversion';
import { donchianBreakout } from './donchianBreakout';
import { evaluateAll, findStrategy, ALL_STRATEGIES, EXPERIMENTAL_STRATEGIES } from './StrategyEngine';
import { quantExperimentalStrategies } from '../../config/quantExperimentalStrategies';

describe('experimental day-trade strategies', () => {
  it('registers every config id as findStrategy-able and keeps live evaluateAll at five by default', () => {
    const configIds = quantExperimentalStrategies.strategies.map(s => s.id);
    expect(EXPERIMENTAL_STRATEGIES.map(s => s.id)).toEqual(configIds);
    for (const id of configIds) {
      expect(ALL_STRATEGIES.map(s => s.id)).not.toContain(id);
      expect(findStrategy(id)?.id).toBe(id);
      expect(process.env[quantExperimentalStrategies.strategies.find(s => s.id === id)!.enabledEnvVar]).not.toBe('true');
    }
    const live = evaluateAll(baseFixture());
    expect(live).toHaveLength(5);
    for (const id of configIds) {
      expect(live.map(r => r.strategy)).not.toContain(id);
    }
  });

  it('includes only the flagged experimental module when its env var is true', () => {
    const row = quantExperimentalStrategies.strategies.find(s => s.id === 'VWAP_VOLUME_STRUCTURE')!;
    const prev = process.env[row.enabledEnvVar];
    process.env[row.enabledEnvVar] = 'true';
    try {
      const results = evaluateAll(baseFixture());
      expect(results.map(r => r.strategy)).toContain('VWAP_VOLUME_STRUCTURE');
      expect(results.map(r => r.strategy)).not.toContain('SMC_LIQUIDITY_SWEEP');
      expect(results).toHaveLength(6);
    } finally {
      if (prev === undefined) delete process.env[row.enabledEnvVar];
      else process.env[row.enabledEnvVar] = prev;
    }
  });

  it('VWAP_VOLUME_STRUCTURE scores a pullback-to-VWAP continuation', () => {
    const ctx = baseFixture();
    ctx.trend.structure.trend = 'UPTREND';
    ctx.regime.regime = 'BULLISH_TREND';
    ctx.volume.vwap.distancePct = 0.1;
    ctx.volume.relativeVolume = quantExperimentalStrategies.thresholds.rvolContinuation;
    ctx.trend.dmi.adx = quantExperimentalStrategies.thresholds.adxTrendMin;
    ctx.priceAction.candlestick = 'HAMMER';
    const result = vwapVolumeStructure.evaluate(ctx);
    expect(result.setupScore).toBe(100);
    expect(result.side).toBe('BUY');
  });

  it('OPENING_RANGE_BREAKOUT fails honestly when opening range is unavailable', () => {
    const result = openingRangeBreakout.evaluate(baseFixture());
    expect(result.conditionsFailed.some(c => c.includes('Opening range'))).toBe(true);
    expect(result.contradictions.some(c => c.includes('daily bars'))).toBe(true);
    expect(result.setupScore).toBeLessThan(100);
  });

  it('OPENING_RANGE_BREAKOUT scores a real OR high break', () => {
    const ctx = baseFixture();
    ctx.supportResistance.openingRange = { available: true, data: { high: 101, low: 99 } };
    ctx.currentPrice = 102;
    ctx.volume.relativeVolume = quantExperimentalStrategies.thresholds.rvolBreakout;
    ctx.volume.vwap.distancePct = 0.5;
    ctx.regime.regime = 'BULLISH_TREND';
    ctx.supportResistance.previousDay = { high: 100, low: 90, close: 95 };
    const result = openingRangeBreakout.evaluate(ctx);
    expect(result.side).toBe('BUY');
    expect(result.setupScore).toBe(100);
  });

  it('VWAP_MEAN_REVERSION scores an extension below VWAP in a range', () => {
    const ctx = baseFixture();
    ctx.regime.regime = 'SIDEWAYS_RANGE';
    ctx.regime.marketStructure = 'RANGING';
    ctx.volume.vwap.distancePct = -quantExperimentalStrategies.thresholds.vwapReversionDistancePct;
    ctx.volume.vwap.event = 'RECLAIM';
    ctx.trend.dmi.adx = quantExperimentalStrategies.thresholds.adxRangeMax - 1;
    ctx.volume.relativeVolume = 1;
    ctx.priceAction.candlestick = 'HAMMER';
    const result = vwapMeanReversion.evaluate(ctx);
    expect(result.side).toBe('BUY');
    expect(result.setupScore).toBe(100);
    expect(result.target.price).toBe(100);
  });

  it('DONCHIAN_CHANNEL_BREAKOUT scores a close above the prior channel', () => {
    const ctx = baseFixture();
    ctx.supportResistance.priorChannel20 = { high: 101, low: 90, close: 100 };
    ctx.currentPrice = 102;
    ctx.trend.dmi.adx = quantExperimentalStrategies.thresholds.adxTrendMin;
    ctx.volume.relativeVolume = quantExperimentalStrategies.thresholds.rvolContinuation;
    ctx.regime.regime = 'BULLISH_TREND';
    ctx.volatility.regime = 'EXPANDING';
    const result = donchianBreakout.evaluate(ctx);
    expect(result.side).toBe('BUY');
    expect(result.setupScore).toBe(100);
  });
});
