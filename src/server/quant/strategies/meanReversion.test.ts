import { describe, it, expect } from 'vitest';
import { meanReversion } from './meanReversion';
import { baseFixture } from './testHelpers';

describe('meanReversion', () => {
  it('scores a full bullish (oversold-fade) setup highly and picks BUY', () => {
    const ctx = baseFixture();
    ctx.regime.regime = 'SIDEWAYS_RANGE';
    ctx.regime.marketStructure = 'RANGING';
    ctx.momentum.rsi = 25;
    ctx.volatility.keltner = { middle: 100, upper: 105, lower: 95 };
    ctx.currentPrice = 94;
    ctx.momentum.stochasticRSI = 10;
    ctx.priceAction.candlestick = 'HAMMER';

    const result = meanReversion.evaluate(ctx);

    expect(result.side).toBe('BUY');
    expect(result.setupScore).toBe(100);
  });

  it('mirrors correctly for an overbought-fade setup -> SELL', () => {
    const ctx = baseFixture();
    ctx.regime.regime = 'SIDEWAYS_RANGE';
    ctx.regime.marketStructure = 'RANGING';
    ctx.momentum.rsi = 75;
    ctx.volatility.keltner = { middle: 100, upper: 105, lower: 95 };
    ctx.currentPrice = 106;
    ctx.momentum.stochasticRSI = 90;
    ctx.priceAction.candlestick = 'SHOOTING_STAR';

    const result = meanReversion.evaluate(ctx);

    expect(result.side).toBe('SELL');
    expect(result.conditionsMet).toContain('RSI overbought (>=70)');
  });

  it('fails the ranging-regime condition during a real trend', () => {
    const ctx = baseFixture();
    ctx.regime.regime = 'BULLISH_TREND';
    ctx.regime.marketStructure = 'TRENDING';
    ctx.momentum.rsi = 25;

    const result = meanReversion.evaluate(ctx);

    expect(result.conditionsFailed).toContain('Ranging / non-trending regime (not a real directional trend)');
  });

  it('flags a real contradiction: fading oversold against a real bearish trend', () => {
    const ctx = baseFixture();
    ctx.regime.regime = 'BEARISH_TREND';
    ctx.momentum.rsi = 25; // oversold -> bullish fade direction

    const result = meanReversion.evaluate(ctx);

    expect(result.contradictions).toContain('Regime is BEARISH_TREND, not ranging - fading an oversold reading against a real downtrend is a materially riskier trade.');
  });

  it('targets the Keltner Channel middle line (the real statistical mean) for a bullish fade', () => {
    const ctx = baseFixture();
    ctx.regime.regime = 'SIDEWAYS_RANGE';
    ctx.momentum.rsi = 25;
    ctx.volatility.keltner = { middle: 101, upper: 106, lower: 96 };
    ctx.supportResistance.nearest = { nearestResistance: null, nearestSupport: { level: 93, abs: 1, pct: 1.1 } };

    const result = meanReversion.evaluate(ctx);

    expect(result.target.price).toBe(101);
    expect(result.target.basis).toContain('Keltner');
    expect(result.stop.price).toBe(93);
  });

  it('reports an honest null stop when no real support/resistance level exists yet', () => {
    const ctx = baseFixture();
    ctx.regime.regime = 'SIDEWAYS_RANGE';
    ctx.momentum.rsi = 25;
    ctx.supportResistance.nearest = { nearestResistance: null, nearestSupport: null };

    const result = meanReversion.evaluate(ctx);

    expect(result.stop.price).toBeNull();
    expect(result.stop.basis).toContain('No real support/resistance level');
  });
});
