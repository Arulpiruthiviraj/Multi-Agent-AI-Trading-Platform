import { describe, it, expect } from 'vitest';
import { baseFixture } from './testHelpers';
import { candlestickReversal } from './candlestickReversal';

/**
 * Real bug found and fixed this pass: DOJI used to be in both BULLISH_CANDLES and
 * BEARISH_CANDLES unconditionally, so a DOJI simultaneously near support AND resistance (or one
 * whose SELL-branch guard otherwise failed) silently defaulted to BUY despite bearishCandle being
 * true - an internally inconsistent signal that also scored "Bullish reversal candle present" as
 * a passed condition. DOJI's direction is now resolved purely by which level it sits nearest to.
 */
describe('candlestickReversal: DOJI direction is resolved by support/resistance proximity, not ambiguous', () => {
  it('a DOJI near resistance only resolves to SELL', () => {
    const ctx = baseFixture();
    ctx.priceAction.candlestick = 'DOJI';
    ctx.supportResistance.nearest = {
      nearestResistance: { level: 105, abs: 0.2, pct: 0.2 },
      nearestSupport: null,
    };
    const result = candlestickReversal.evaluate(ctx);
    expect(result.side).toBe('SELL');
    expect(result.conditionsMet).not.toContain('Bullish reversal candle (hammer/engulfing/doji)');
  });

  it('a DOJI near support only resolves to BUY', () => {
    const ctx = baseFixture();
    ctx.priceAction.candlestick = 'DOJI';
    ctx.supportResistance.nearest = {
      nearestResistance: null,
      nearestSupport: { level: 95, abs: -0.2, pct: -0.2 },
    };
    const result = candlestickReversal.evaluate(ctx);
    expect(result.side).toBe('BUY');
    expect(result.conditionsMet).toContain('Bullish reversal candle (hammer/engulfing/doji)');
  });

  it('a DOJI near BOTH support and resistance is not falsely scored as a clean bullish setup', () => {
    const ctx = baseFixture();
    ctx.priceAction.candlestick = 'DOJI';
    ctx.supportResistance.nearest = {
      nearestResistance: { level: 105, abs: 0.2, pct: 0.2 },
      nearestSupport: { level: 95, abs: -0.2, pct: -0.2 },
    };
    const result = candlestickReversal.evaluate(ctx);
    // No directional edge from location alone - falls through to the default BUY branch, but
    // must not claim a passed "bullish reversal candle" condition it doesn't actually have.
    expect(result.side).toBe('BUY');
    expect(result.conditionsMet).not.toContain('Bullish reversal candle (hammer/engulfing/doji)');
  });
});
