/**
 * ==========================================================
 * Module: strategies/pullbackContinuation
 *
 * Purpose:
 * Phase 4 - Pullback Continuation: an established trend (per Phase 2's real market-structure
 * classification, not a guess) has retraced to a moving average without breaking it, RSI is in a
 * healthy (not extreme) zone, and volume contracted during the pullback - the classic "buy the dip
 * in an uptrend" / "sell the rally in a downtrend" setup. Bidirectional, mirrored on trend.structure.trend.
 * ==========================================================
 */
import { StrategyContext, StrategyDefinition, StrategyEvaluation, scoreFromConditions } from './types';
import { quantThresholds } from '../../config/quantThresholds';

const PULLBACK_TOLERANCE_PCT = quantThresholds.pullbackTolerancePct;
const HEALTHY_RSI_MIN = quantThresholds.healthyRsiMin;
const HEALTHY_RSI_MAX = quantThresholds.healthyRsiMax;

export const pullbackContinuation: StrategyDefinition = {
  id: 'PULLBACK_CONTINUATION',
  displayName: 'Pullback Continuation',
  applicableRegimes: ['BULLISH_TREND', 'BEARISH_TREND'],

  evaluate(ctx: StrategyContext): StrategyEvaluation {
    const { trend, momentum, volume, priceAction, supportResistance, regime } = ctx;

    const bullish = trend.structure.trend === 'UPTREND' || (trend.structure.trend !== 'DOWNTREND' && regime.regime === 'BULLISH_TREND');
    const side: 'BUY' | 'SELL' = bullish ? 'BUY' : 'SELL';

    const conditionsMet: string[] = [];
    const conditionsFailed: string[] = [];
    const contradictions: string[] = [];
    const check = (name: string, met: boolean) => (met ? conditionsMet.push(name) : conditionsFailed.push(name));

    check(
      bullish ? 'Established uptrend (market structure + regime)' : 'Established downtrend (market structure + regime)',
      bullish
        ? trend.structure.trend === 'UPTREND' && regime.regime === 'BULLISH_TREND'
        : trend.structure.trend === 'DOWNTREND' && regime.regime === 'BEARISH_TREND'
    );

    const pvma20 = trend.priceVsSMA20;
    check(
      'Price pulled back to/near SMA20 without breaking decisively through it',
      pvma20 !== null &&
        Math.abs(pvma20.diffPct) <= PULLBACK_TOLERANCE_PCT &&
        (bullish ? pvma20.diffPct > -PULLBACK_TOLERANCE_PCT : pvma20.diffPct < PULLBACK_TOLERANCE_PCT)
    );

    check('RSI in a healthy (non-extreme) pullback zone', momentum.rsi >= HEALTHY_RSI_MIN && momentum.rsi <= HEALTHY_RSI_MAX);

    check(
      bullish ? 'Bullish reversal candlestick at the pullback low' : 'Bearish reversal candlestick at the pullback high',
      bullish
        ? priceAction.candlestick === 'HAMMER' || priceAction.candlestick === 'BULLISH_ENGULFING'
        : priceAction.candlestick === 'SHOOTING_STAR' || priceAction.candlestick === 'BEARISH_ENGULFING'
    );

    check(
      'Volume contracted during the pullback (below average - lack of opposing pressure)',
      volume.relativeVolume !== null && volume.relativeVolume < 1
    );

    check(
      'No structural reversal against the trend (no opposing CHoCH)',
      bullish ? trend.structure.event !== 'CHOCH_BEARISH' : trend.structure.event !== 'CHOCH_BULLISH'
    );

    if (bullish && trend.dmi && trend.dmi.minusDI > trend.dmi.plusDI) {
      contradictions.push('DMI shows -DI > +DI despite a bullish pullback setup - directional momentum has already flipped bearish.');
    }
    if (!bullish && trend.dmi && trend.dmi.plusDI > trend.dmi.minusDI) {
      contradictions.push('DMI shows +DI > -DI despite a bearish pullback setup - directional momentum has already flipped bullish.');
    }

    const totalConditions = conditionsMet.length + conditionsFailed.length;
    const setupScore = scoreFromConditions(conditionsMet, totalConditions);

    const maValue = trend.movingAverages.sma20;
    const structuralStop = bullish ? trend.structure.lastSwingLow : trend.structure.lastSwingHigh;
    const target = bullish ? supportResistance.nearest.nearestResistance : supportResistance.nearest.nearestSupport;

    return {
      strategy: 'PULLBACK_CONTINUATION',
      side,
      setupScore,
      confidence: setupScore / 100,
      conditionsMet,
      conditionsFailed,
      contradictions,
      invalidationConditions: [
        `Price closes decisively ${bullish ? 'below' : 'above'} SMA20 / the pullback low${bullish ? '' : ' (high)'}.`,
        `Market structure flips to ${bullish ? 'CHOCH_BEARISH' : 'CHOCH_BULLISH'}.`,
      ],
      stop: structuralStop !== null
        ? { price: structuralStop, basis: `Most recent real swing ${bullish ? 'low' : 'high'} (${structuralStop.toFixed(2)}) that defines the pullback.` }
        : maValue !== null
        ? { price: maValue, basis: 'SMA20 value (no real swing point available yet).' }
        : { price: null, basis: 'No real swing point or SMA20 available yet to derive a stop.' },
      target: target
        ? { price: target.level, basis: `Nearest real ${bullish ? 'resistance' : 'support'} level - the prior trend ${bullish ? 'high' : 'low'} being retested.` }
        : { price: null, basis: 'No further real level available yet to derive a target.' },
      applicableRegimes: pullbackContinuation.applicableRegimes,
    };
  },
};
