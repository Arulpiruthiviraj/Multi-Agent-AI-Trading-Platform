/**
 * ==========================================================
 * Module: strategies/statisticalMeanReversion
 *
 * Purpose:
 * Experimental: fade a close-price z-score extreme (|z| >= config closePriceZScoreAbs) with an
 * RSI extreme in a range. Uses statistics.ts zScore via VolatilityFeatures.closePriceZScore —
 * not a fabricated 2.5σ. Distinct from CORE MEAN_REVERSION (Keltner + StochRSI).
 *
 * Live vs backtest:
 *   findStrategy() without the live flag; evaluateAll() only if QUANT_STATISTICAL_REVERSION_ENABLED=true.
 *
 * Status: UNVALIDATED. Not pairs/cointegration. BacktestEngine is long-only.
 * ==========================================================
 */
import { StrategyContext, StrategyDefinition, StrategyEvaluation, scoreFromConditions } from './types';
import { quantExperimentalStrategies } from '../../config/quantExperimentalStrategies';
import { quantThresholds } from '../../config/quantThresholds';

const t = quantExperimentalStrategies.thresholds;
const RSI_OVERSOLD = quantThresholds.rsiOversold;
const RSI_OVERBOUGHT = quantThresholds.rsiOverbought;

export const statisticalMeanReversion: StrategyDefinition = {
  id: 'STATISTICAL_MEAN_REVERSION',
  displayName: 'Statistical Mean Reversion (z-score)',
  applicableRegimes: ['SIDEWAYS_RANGE'],

  evaluate(ctx: StrategyContext): StrategyEvaluation {
    const { volatility, momentum, regime, currentPrice } = ctx;
    const z = volatility.closePriceZScore;
    const stretchedDown = z !== null && z <= -t.closePriceZScoreAbs;
    const stretchedUp = z !== null && z >= t.closePriceZScoreAbs;
    const bullish = stretchedUp ? false : true;
    const side: 'BUY' | 'SELL' = bullish ? 'BUY' : 'SELL';

    const conditionsMet: string[] = [];
    const conditionsFailed: string[] = [];
    const contradictions: string[] = [];
    const check = (name: string, met: boolean) => (met ? conditionsMet.push(name) : conditionsFailed.push(name));

    check(
      `Close z-score available (${t.closePriceZScoreLookback}-bar window)`,
      z !== null,
    );
    check(
      bullish
        ? `Close z-score <= -${t.closePriceZScoreAbs}`
        : `Close z-score >= ${t.closePriceZScoreAbs}`,
      bullish ? stretchedDown : stretchedUp,
    );
    check(
      bullish ? `RSI oversold (<= ${RSI_OVERSOLD})` : `RSI overbought (>= ${RSI_OVERBOUGHT})`,
      bullish ? momentum.rsi <= RSI_OVERSOLD : momentum.rsi >= RSI_OVERBOUGHT,
    );
    check(
      'Ranging regime (not fading a trend as a default)',
      regime.regime === 'SIDEWAYS_RANGE' || regime.marketStructure === 'RANGING',
    );
    check(
      `ADX below range ceiling (< ${t.adxRangeMax})`,
      ctx.trend.dmi.adx !== null && ctx.trend.dmi.adx < t.adxRangeMax,
    );

    if (bullish && regime.regime === 'BEARISH_TREND') {
      contradictions.push('Fading a negative z-score against BEARISH_TREND — non-stationary series can keep falling.');
    }
    if (!bullish && regime.regime === 'BULLISH_TREND') {
      contradictions.push('Fading a positive z-score against BULLISH_TREND — non-stationary series can keep rising.');
    }

    const totalConditions = conditionsMet.length + conditionsFailed.length;
    const setupScore = scoreFromConditions(conditionsMet, totalConditions);
    const meanProxy = volatility.keltner?.middle ?? currentPrice;
    const atr = volatility.atr;

    return {
      strategy: 'STATISTICAL_MEAN_REVERSION',
      side,
      setupScore,
      confidence: setupScore / 100,
      conditionsMet,
      conditionsFailed,
      contradictions,
      invalidationConditions: [
        'Market structure trend flips against the fade.',
        `ADX rises through ${t.adxRangeMax} (range thesis gone).`,
        'Z-score continues through the extreme without reverting (non-stationary).',
      ],
      stop: atr
        ? { price: currentPrice + (bullish ? -atr : atr), basis: '1x ATR beyond the stretched print.' }
        : { price: null, basis: 'No ATR for a stop.' },
      target: { price: meanProxy, basis: 'Keltner middle as the mean proxy (z-score mean is the rolling SMA, not stored as a level).' },
      applicableRegimes: statisticalMeanReversion.applicableRegimes,
    };
  },
};
