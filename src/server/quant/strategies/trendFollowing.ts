/**
 * ==========================================================
 * Module: strategies/trendFollowing
 *
 * Purpose:
 * Phase 4 - Trend Following: rides an already-established, real TRENDING regime (not waiting for a
 * pullback like pullbackContinuation.ts) - confirmed by MA ordering, real double-smoothed DMI/ADX
 * (indicators/trend.ts's calculateDMI, not the existing untouched calculateADX), MACD, and money
 * flow (CMF). Deliberately has no fixed target - trend-following strategies trail a stop rather
 * than targeting a fixed price, and this is stated honestly rather than fabricating a number.
 * ==========================================================
 */
import { StrategyContext, StrategyDefinition, StrategyEvaluation, scoreFromConditions } from './types';

const MIN_TREND_STRENGTH = 50;
const MIN_ADX = 25;

export const trendFollowing: StrategyDefinition = {
  id: 'TREND_FOLLOWING',
  displayName: 'Trend Following',
  applicableRegimes: ['BULLISH_TREND', 'BEARISH_TREND'],

  evaluate(ctx: StrategyContext): StrategyEvaluation {
    const { trend, momentum, volume, regime } = ctx;
    const bullish = regime.regime !== 'BEARISH_TREND';
    const side: 'BUY' | 'SELL' = bullish ? 'BUY' : 'SELL';
    const ma = trend.movingAverages;

    const conditionsMet: string[] = [];
    const conditionsFailed: string[] = [];
    const contradictions: string[] = [];
    const check = (name: string, met: boolean) => (met ? conditionsMet.push(name) : conditionsFailed.push(name));

    check(
      bullish ? 'Strong BULLISH_TREND regime (trendStrength >= 50)' : 'Strong BEARISH_TREND regime (trendStrength >= 50)',
      (bullish ? regime.regime === 'BULLISH_TREND' : regime.regime === 'BEARISH_TREND') && regime.trendStrength >= MIN_TREND_STRENGTH
    );
    check('Market structure real TRENDING (not ranging/choppy)', regime.marketStructure === 'TRENDING');
    check(
      bullish ? 'Moving averages ordered bullishly (SMA20 > SMA50 > SMA200)' : 'Moving averages ordered bearishly (SMA20 < SMA50 < SMA200)',
      ma.sma20 !== null && ma.sma50 !== null && ma.sma200 !== null &&
        (bullish ? ma.sma20 > ma.sma50 && ma.sma50 > ma.sma200 : ma.sma20 < ma.sma50 && ma.sma50 < ma.sma200)
    );
    check(
      bullish ? 'DMI +DI > -DI with real ADX trend strength' : 'DMI -DI > +DI with real ADX trend strength',
      trend.dmi !== null && trend.dmi.adx >= MIN_ADX && (bullish ? trend.dmi.plusDI > trend.dmi.minusDI : trend.dmi.minusDI > trend.dmi.plusDI)
    );
    check(
      bullish ? 'MACD bullish (line above signal)' : 'MACD bearish (line below signal)',
      bullish ? momentum.macd.macd > momentum.macd.signal : momentum.macd.macd < momentum.macd.signal
    );
    check(
      bullish ? 'Chaikin Money Flow confirming accumulation (CMF > 0)' : 'Chaikin Money Flow confirming distribution (CMF < 0)',
      volume.cmf !== null && (bullish ? volume.cmf > 0 : volume.cmf < 0)
    );

    if (bullish && trend.priceVsSMA200 !== null && !trend.priceVsSMA200.above) {
      contradictions.push('Price is below SMA200 despite a bullish trend-following signal - the long-term trend disagrees with the short/medium-term read.');
    }
    if (!bullish && trend.priceVsSMA200 !== null && trend.priceVsSMA200.above) {
      contradictions.push('Price is above SMA200 despite a bearish trend-following signal - the long-term trend disagrees with the short/medium-term read.');
    }

    const totalConditions = conditionsMet.length + conditionsFailed.length;
    const setupScore = scoreFromConditions(conditionsMet, totalConditions);

    const trailStop = ma.sma50;

    return {
      strategy: 'TREND_FOLLOWING',
      side,
      setupScore,
      confidence: setupScore / 100,
      conditionsMet,
      conditionsFailed,
      contradictions,
      invalidationConditions: [
        'ADX falls below 20 (real trend strength fading - market structure shifting toward RANGING/CHOPPY).',
        `A structural CHoCH event occurs against the ${bullish ? 'uptrend' : 'downtrend'}.`,
      ],
      stop: trailStop !== null
        ? { price: trailStop, basis: 'SMA50 as a trailing stop - designed to be moved with the trend, not a fixed level.' }
        : { price: null, basis: 'No real SMA50 available yet to derive a trailing stop.' },
      target: { price: null, basis: 'Trend-following is intentionally open-ended - no fixed target; trail the stop (e.g. along SMA50) as the trend extends.' },
      applicableRegimes: trendFollowing.applicableRegimes,
    };
  },
};
