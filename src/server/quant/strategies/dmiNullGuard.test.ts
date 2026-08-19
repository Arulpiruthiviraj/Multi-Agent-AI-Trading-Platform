import { describe, it, expect } from 'vitest';
import { baseFixture } from './testHelpers';
import { bollingerVolatility } from './bollingerVolatility';
import { donchianBreakout } from './donchianBreakout';
import { maCrossover } from './maCrossover';
import { oscillatorMomentum } from './oscillatorMomentum';
import { relativeStrengthRotation } from './relativeStrengthRotation';
import { statisticalMeanReversion } from './statisticalMeanReversion';
import { vwapMeanReversion } from './vwapMeanReversion';
import { vwapVolumeStructure } from './vwapVolumeStructure';
import type { StrategyDefinition } from './types';

/**
 * Real bug found and fixed this pass: `trend.dmi` is typed `DMIResult | null` (calculateDMI
 * returns null below its minimum bar requirement, ~29 bars for the default period), but all 8
 * strategies below accessed `trend.dmi.adx` directly - checking only `.adx !== null`, which
 * throws a TypeError once trend.dmi itself is null, instead of first checking `trend.dmi !== null`
 * the way trendFollowing.ts/pullbackContinuation.ts already correctly do.
 *
 * This was masked in every live/backtest/replay path today because every caller gates on
 * bars.length >= regimeMinBars (60), which exceeds DMI's 29-bar requirement - but
 * StrategyEngine.evaluateAll()'s per-strategy loop has no try/catch, so a null dmi reaching any
 * one of these would have aborted evaluation for every strategy on that symbol that cycle, not
 * just the affected one.
 */
describe('quant strategies do not throw when trend.dmi is null', () => {
  const strategies: StrategyDefinition[] = [
    bollingerVolatility,
    donchianBreakout,
    maCrossover,
    oscillatorMomentum,
    relativeStrengthRotation,
    statisticalMeanReversion,
    vwapMeanReversion,
    vwapVolumeStructure,
  ];

  for (const strategy of strategies) {
    it(`${strategy.id}: evaluate() does not throw with trend.dmi = null`, () => {
      const ctx = baseFixture();
      ctx.trend.dmi = null;
      expect(() => strategy.evaluate(ctx)).not.toThrow();
    });
  }
});
