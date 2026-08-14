import { describe, it, expect } from 'vitest';
import { momentumBreakout } from './momentumBreakout';
import { baseFixture } from './testHelpers';

describe('momentumBreakout', () => {
  it('scores a full bullish breakout setup highly and picks BUY', () => {
    const ctx = baseFixture();
    ctx.trend.structure = { trend: 'UPTREND', event: 'BOS_BULLISH', lastSwingHigh: 105, lastSwingLow: 95 };
    ctx.volume.relativeVolume = 2.0;
    ctx.volatility.regime = 'EXPANDING';
    ctx.volume.vwap = { vwap: 98, distancePct: 2, slopePct: 1, event: 'RECLAIM' };
    ctx.regime.regime = 'BULLISH_TREND';
    ctx.marketContext.sector.trend = { symbol: 'XLK', regime: { regime: 'BULLISH_TREND', trendStrength: 80, volatility: 'NORMAL', marketStructure: 'TRENDING', confidence: 0.8, features: {} as any, insufficientData: false }, source: 'test' };
    ctx.marketContext.relativeStrengthVsSPY = { vsSymbol: 'SPY', periodPct: 5, benchmarkPeriodPct: 2, relativeStrengthPct: 3, correlation: 0.5, beta: 1.1, source: 'test' };
    ctx.momentum.roc = 4;

    const result = momentumBreakout.evaluate(ctx);

    expect(result.side).toBe('BUY');
    expect(result.setupScore).toBe(100);
    expect(result.confidence).toBe(1);
    expect(result.conditionsFailed).toHaveLength(0);
    expect(result.strategy).toBe('MOMENTUM_BREAKOUT');
  });

  it('mirrors correctly for a bearish breakdown (BOS_BEARISH) -> SELL', () => {
    const ctx = baseFixture();
    ctx.trend.structure = { trend: 'DOWNTREND', event: 'BOS_BEARISH', lastSwingHigh: 105, lastSwingLow: 95 };
    ctx.volume.relativeVolume = 2.0;
    ctx.volatility.regime = 'EXPANDING';
    ctx.volume.vwap = { vwap: 102, distancePct: -2, slopePct: -1, event: 'REJECTION' };
    ctx.regime.regime = 'BEARISH_TREND';
    ctx.momentum.roc = -3;

    const result = momentumBreakout.evaluate(ctx);

    expect(result.side).toBe('SELL');
    expect(result.conditionsMet).toContain('Structural break in trade direction (BOS)');
  });

  it('fails conditions honestly when RVOL/ATR expansion/VWAP position are absent', () => {
    const ctx = baseFixture();
    ctx.trend.structure = { trend: 'UPTREND', event: 'BOS_BULLISH', lastSwingHigh: 105, lastSwingLow: 95 };
    // Everything else stays at the neutral fixture defaults - RVOL=1 (below 1.5x), volatility STABLE, VWAP flat.

    const result = momentumBreakout.evaluate(ctx);

    expect(result.conditionsFailed).toContain('RVOL confirmation (>=1.5x average volume)');
    expect(result.conditionsFailed).toContain('ATR expansion (volatility regime EXPANDING)');
    expect(result.setupScore).toBeLessThan(100);
  });

  it('flags a real contradiction: bullish breakout with RSI already extremely overbought', () => {
    const ctx = baseFixture();
    ctx.trend.structure = { trend: 'UPTREND', event: 'BOS_BULLISH', lastSwingHigh: 105, lastSwingLow: 95 };
    ctx.momentum.rsi = 85;

    const result = momentumBreakout.evaluate(ctx);

    expect(result.contradictions).toContain('RSI already extremely overbought (>=80) on a fresh bullish breakout - elevated risk of immediate failure/exhaustion.');
  });

  it('derives stop/target from the broken structural level and ATR, with an honest basis string', () => {
    const ctx = baseFixture();
    ctx.trend.structure = { trend: 'UPTREND', event: 'BOS_BULLISH', lastSwingHigh: 105, lastSwingLow: 95 };
    ctx.volatility.atr = 2;
    ctx.currentPrice = 106;
    ctx.supportResistance.nearest = { nearestResistance: { level: 110, abs: -4, pct: -3.6 }, nearestSupport: null };

    const result = momentumBreakout.evaluate(ctx);

    expect(result.stop.price).toBe(103); // lastSwingHigh(105) - 1x ATR(2)
    expect(result.stop.basis).toContain('ATR');
    expect(result.target.price).toBe(110); // nearest resistance beyond the breakout
  });

  it('falls back to a 2x-ATR measured-move target when no further real S/R level exists', () => {
    const ctx = baseFixture();
    ctx.trend.structure = { trend: 'UPTREND', event: 'BOS_BULLISH', lastSwingHigh: 105, lastSwingLow: 95 };
    ctx.volatility.atr = 2;
    ctx.currentPrice = 106;
    ctx.supportResistance.nearest = { nearestResistance: null, nearestSupport: null };

    const result = momentumBreakout.evaluate(ctx);

    expect(result.target.price).toBe(110); // 106 + 2*2
    expect(result.target.basis).toContain('measured move');
  });

  it('reports applicableRegimes matching the strategy definition, for StrategyEngine\'s regime-fit discount', () => {
    const result = momentumBreakout.evaluate(baseFixture());
    expect(result.applicableRegimes).toEqual(['BULLISH_TREND', 'BEARISH_TREND']);
  });
});
