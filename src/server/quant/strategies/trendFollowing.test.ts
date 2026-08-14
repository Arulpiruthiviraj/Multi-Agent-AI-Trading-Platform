import { describe, it, expect } from 'vitest';
import { trendFollowing } from './trendFollowing';
import { baseFixture } from './testHelpers';

describe('trendFollowing', () => {
  it('scores a full bullish trend-following setup highly and picks BUY', () => {
    const ctx = baseFixture();
    ctx.regime.regime = 'BULLISH_TREND';
    ctx.regime.trendStrength = 70;
    ctx.regime.marketStructure = 'TRENDING';
    ctx.trend.movingAverages = { ...ctx.trend.movingAverages, sma20: 110, sma50: 105, sma200: 95 };
    ctx.trend.dmi = { plusDI: 30, minusDI: 10, adx: 30 };
    ctx.momentum.macd = { macd: 1.5, signal: 0.8, histogram: 0.7 };
    ctx.volume.cmf = 0.2;
    ctx.trend.priceVsSMA200 = { diff: 10, diffPct: 10, above: true };

    const result = trendFollowing.evaluate(ctx);

    expect(result.side).toBe('BUY');
    expect(result.setupScore).toBe(100);
    expect(result.contradictions).toHaveLength(0);
  });

  it('mirrors correctly for a bearish trend -> SELL', () => {
    const ctx = baseFixture();
    ctx.regime.regime = 'BEARISH_TREND';
    ctx.regime.trendStrength = 70;
    ctx.regime.marketStructure = 'TRENDING';
    ctx.trend.movingAverages = { ...ctx.trend.movingAverages, sma20: 90, sma50: 95, sma200: 105 };
    ctx.trend.dmi = { plusDI: 10, minusDI: 30, adx: 30 };
    ctx.momentum.macd = { macd: -1.5, signal: -0.8, histogram: -0.7 };
    ctx.volume.cmf = -0.2;
    ctx.trend.priceVsSMA200 = { diff: -10, diffPct: -10, above: false };

    const result = trendFollowing.evaluate(ctx);

    expect(result.side).toBe('SELL');
    expect(result.conditionsMet).toContain('Moving averages ordered bearishly (SMA20 < SMA50 < SMA200)');
  });

  it('fails the trend-strength condition when regime.trendStrength is below the minimum', () => {
    const ctx = baseFixture();
    ctx.regime.regime = 'BULLISH_TREND';
    ctx.regime.trendStrength = 30; // below MIN_TREND_STRENGTH (50)

    const result = trendFollowing.evaluate(ctx);

    expect(result.conditionsFailed).toContain('Strong BULLISH_TREND regime (trendStrength >= 50)');
  });

  it('flags a real contradiction: bullish trend-following signal but price below SMA200', () => {
    const ctx = baseFixture();
    ctx.regime.regime = 'BULLISH_TREND';
    ctx.trend.priceVsSMA200 = { diff: -5, diffPct: -5, above: false };

    const result = trendFollowing.evaluate(ctx);

    expect(result.contradictions).toContain('Price is below SMA200 despite a bullish trend-following signal - the long-term trend disagrees with the short/medium-term read.');
  });

  it('uses SMA50 as an explicitly open-ended trailing stop, with no fixed target', () => {
    const ctx = baseFixture();
    ctx.regime.regime = 'BULLISH_TREND';
    ctx.trend.movingAverages.sma50 = 108;

    const result = trendFollowing.evaluate(ctx);

    expect(result.stop.price).toBe(108);
    expect(result.stop.basis).toContain('trailing stop');
    expect(result.target.price).toBeNull();
    expect(result.target.basis).toContain('intentionally open-ended');
  });
});
