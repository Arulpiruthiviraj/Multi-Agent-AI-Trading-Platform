import { describe, it, expect } from 'vitest';
import { pullbackContinuation } from './pullbackContinuation';
import { baseFixture } from './testHelpers';

describe('pullbackContinuation', () => {
  it('scores a full bullish pullback-in-uptrend setup highly and picks BUY', () => {
    const ctx = baseFixture();
    ctx.trend.structure = { trend: 'UPTREND', event: 'NONE', lastSwingHigh: 110, lastSwingLow: 98 };
    ctx.regime.regime = 'BULLISH_TREND';
    ctx.trend.priceVsSMA20 = { diff: -1, diffPct: -1, above: false };
    ctx.momentum.rsi = 50;
    ctx.priceAction.candlestick = 'HAMMER';
    ctx.volume.relativeVolume = 0.7;
    ctx.trend.dmi = { plusDI: 30, minusDI: 10, adx: 25 };

    const result = pullbackContinuation.evaluate(ctx);

    expect(result.side).toBe('BUY');
    expect(result.setupScore).toBe(100);
    expect(result.contradictions).toHaveLength(0);
  });

  it('mirrors correctly for a bearish pullback-in-downtrend (rally into a downtrend) -> SELL', () => {
    const ctx = baseFixture();
    ctx.trend.structure = { trend: 'DOWNTREND', event: 'NONE', lastSwingHigh: 110, lastSwingLow: 98 };
    ctx.regime.regime = 'BEARISH_TREND';
    ctx.trend.priceVsSMA20 = { diff: 1, diffPct: 1, above: true };
    ctx.momentum.rsi = 50;
    ctx.priceAction.candlestick = 'SHOOTING_STAR';
    ctx.volume.relativeVolume = 0.7;
    ctx.trend.dmi = { plusDI: 10, minusDI: 30, adx: 25 };

    const result = pullbackContinuation.evaluate(ctx);

    expect(result.side).toBe('SELL');
    expect(result.conditionsMet).toContain('Established downtrend (market structure + regime)');
  });

  it('fails the RSI-healthy-zone condition when RSI is already extreme', () => {
    const ctx = baseFixture();
    ctx.trend.structure = { trend: 'UPTREND', event: 'NONE', lastSwingHigh: 110, lastSwingLow: 98 };
    ctx.regime.regime = 'BULLISH_TREND';
    ctx.momentum.rsi = 85; // extreme, not a "healthy pullback zone" reading

    const result = pullbackContinuation.evaluate(ctx);

    expect(result.conditionsFailed).toContain('RSI in a healthy (non-extreme) pullback zone');
  });

  it('flags a real contradiction: bullish setup but DMI has already flipped bearish', () => {
    const ctx = baseFixture();
    ctx.trend.structure = { trend: 'UPTREND', event: 'NONE', lastSwingHigh: 110, lastSwingLow: 98 };
    ctx.regime.regime = 'BULLISH_TREND';
    ctx.trend.dmi = { plusDI: 10, minusDI: 25, adx: 20 };

    const result = pullbackContinuation.evaluate(ctx);

    expect(result.contradictions).toContain('DMI shows -DI > +DI despite a bullish pullback setup - directional momentum has already flipped bearish.');
  });

  it('derives a stop from the most recent real swing low for a bullish pullback', () => {
    const ctx = baseFixture();
    ctx.trend.structure = { trend: 'UPTREND', event: 'NONE', lastSwingHigh: 110, lastSwingLow: 98 };
    ctx.regime.regime = 'BULLISH_TREND';
    ctx.supportResistance.nearest = { nearestResistance: { level: 112, abs: 2, pct: 1.8 }, nearestSupport: null };

    const result = pullbackContinuation.evaluate(ctx);

    expect(result.stop.price).toBe(98);
    expect(result.stop.basis).toContain('swing');
    expect(result.target.price).toBe(112);
  });

  it('falls back to SMA20 for the stop when no real swing point exists yet', () => {
    const ctx = baseFixture();
    ctx.trend.structure = { trend: 'UPTREND', event: 'NONE', lastSwingHigh: null, lastSwingLow: null };
    ctx.regime.regime = 'BULLISH_TREND';
    ctx.trend.movingAverages.sma20 = 97;

    const result = pullbackContinuation.evaluate(ctx);

    expect(result.stop.price).toBe(97);
    expect(result.stop.basis).toContain('SMA20');
  });
});
