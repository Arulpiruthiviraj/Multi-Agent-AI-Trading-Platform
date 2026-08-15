import { describe, it, expect } from 'vitest';
import { smcLiquiditySweep } from './smcLiquiditySweep';
import { baseFixture } from './testHelpers';
import { smcConfluence } from '../../config/smcConfluence';
import type { SmcFeatures } from '../indicators/smc';
import { findStrategy, evaluateAll, ALL_STRATEGIES, EXPERIMENTAL_STRATEGIES } from './StrategyEngine';

function smcFixture(over: Partial<SmcFeatures> = {}): SmcFeatures {
  return {
    structure: { trend: 'DOWNTREND', event: 'CHOCH_BULLISH', lastSwingHigh: 110, lastSwingLow: 90 },
    liquidity: {
      buySide: { price: 110, kind: 'SWING_HIGH' },
      sellSide: { price: 90, kind: 'SWING_LOW' },
      equalHighs: false,
      equalLows: true,
    },
    sweep: {
      kind: 'SELL_SIDE_SWEPT',
      isTradeSignal: false,
      sweptLevel: 90,
      sweepExtreme: 88,
      closedBackInside: true,
      detail: 'test',
    },
    displacement: { present: true, direction: 'UP', rangeMultiple: 2, barIndex: 20 },
    orderBlock: { side: 'BULLISH', low: 92, high: 96, overlappingPrice: true, filled: null },
    fairValueGap: { side: 'BULLISH', low: 94, high: 98, overlappingPrice: true, filled: false },
    trap: { kind: 'BEAR_TRAP', isIntentionalManipulation: false, detail: 'pattern only' },
    ...over,
  };
}

describe('smcLiquiditySweep', () => {
  it('scores a sweep-plus-CHoCH confluence as BUY and never treats the sweep as an automatic signal', () => {
    const ctx = baseFixture();
    ctx.regime.regime = 'BULLISH_TREND';
    ctx.volume.relativeVolume = 2;
    ctx.smc = smcFixture();

    const result = smcLiquiditySweep.evaluate(ctx);
    expect(result.strategy).toBe('SMC_LIQUIDITY_SWEEP');
    expect(result.side).toBe('BUY');
    expect(result.setupScore).toBe(100);
    expect(result.conditionsMet.some(c => c.includes('not a trade by itself'))).toBe(true);
    expect(result.stop.price).toBeCloseTo(88 - ctx.volatility.atr, 8);
    expect(result.target.price).toBe(110);
  });

  it('does not treat a sweep without CHoCH as a confirmed reversal', () => {
    const ctx = baseFixture();
    ctx.regime.regime = 'BULLISH_TREND';
    ctx.volume.relativeVolume = 2;
    ctx.smc = smcFixture({
      structure: { trend: 'DOWNTREND', event: 'NONE', lastSwingHigh: 110, lastSwingLow: 90 },
    });

    const result = smcLiquiditySweep.evaluate(ctx);
    expect(result.conditionsFailed.some(c => c.startsWith('CHoCH confirmation'))).toBe(true);
    expect(result.contradictions.some(c => c.includes('Sweep without CHoCH'))).toBe(true);
    expect(result.setupScore).toBe(100 - smcConfluence.chochConfirmed);
  });

  it('is not part of the live evaluateAll set by default', () => {
    expect(ALL_STRATEGIES.map(s => s.id)).not.toContain('SMC_LIQUIDITY_SWEEP');
    expect(EXPERIMENTAL_STRATEGIES.map(s => s.id)).toContain('SMC_LIQUIDITY_SWEEP');
    expect(findStrategy('SMC_LIQUIDITY_SWEEP')?.id).toBe('SMC_LIQUIDITY_SWEEP');
    const results = evaluateAll(baseFixture());
    expect(results).toHaveLength(5);
    expect(results.map(r => r.strategy)).not.toContain('SMC_LIQUIDITY_SWEEP');
  });
});
