/**
 * ==========================================================
 * Module: strategies/vwapMeanReversion
 *
 * Purpose:
 * Experimental: fade an extension away from session VWAP in a low-ADX range, with a reversal
 * candle. Distinct from core MEAN_REVERSION (Keltner + RSI). Does not invent Bollinger bands
 * (VolatilityFeatures only exposes bollingerBandWidthPct).
 *
 * Live vs backtest:
 *   findStrategy() without the live flag; evaluateAll() only if QUANT_VWAP_REVERSION_ENABLED=true.
 *
 * Status: UNVALIDATED.
 * ==========================================================
 */
import { StrategyContext, StrategyDefinition, StrategyEvaluation, scoreFromConditions } from './types';
import { quantExperimentalStrategies } from '../../config/quantExperimentalStrategies';

const t = quantExperimentalStrategies.thresholds;

export const vwapMeanReversion: StrategyDefinition = {
  id: 'VWAP_MEAN_REVERSION',
  displayName: 'VWAP Mean Reversion',
  applicableRegimes: ['SIDEWAYS_RANGE'],

  evaluate(ctx: StrategyContext): StrategyEvaluation {
    const { volume, trend, priceAction, regime, volatility, supportResistance, currentPrice } = ctx;
    const dist = volume.vwap.distancePct;
    const extendedDown = dist !== null && dist <= -t.vwapReversionDistancePct;
    const extendedUp = dist !== null && dist >= t.vwapReversionDistancePct;
    const bullish = extendedUp ? false : true;
    const side: 'BUY' | 'SELL' = bullish ? 'BUY' : 'SELL';

    const conditionsMet: string[] = [];
    const conditionsFailed: string[] = [];
    const contradictions: string[] = [];
    const check = (name: string, met: boolean) => (met ? conditionsMet.push(name) : conditionsFailed.push(name));

    check(
      'Ranging / non-trending regime',
      regime.regime === 'SIDEWAYS_RANGE' || regime.marketStructure === 'RANGING',
    );
    check(
      bullish
        ? `Extended below VWAP (distancePct <= -${t.vwapReversionDistancePct})`
        : `Extended above VWAP (distancePct >= ${t.vwapReversionDistancePct})`,
      bullish ? extendedDown : extendedUp,
    );
    check(
      `ADX below range ceiling (< ${t.adxRangeMax})`,
      // Real bug found and fixed this pass: trend.dmi is DMIResult | null - guard it before .adx.
      trend.dmi !== null && trend.dmi.adx !== null && trend.dmi.adx < t.adxRangeMax,
    );
    check(
      `Volume not a trend-day expansion (RVOL < ${t.rvolContinuation})`,
      volume.relativeVolume !== null && volume.relativeVolume < t.rvolContinuation,
    );
    check(
      bullish ? 'Bullish reversal candlestick' : 'Bearish reversal candlestick',
      bullish
        ? priceAction.candlestick === 'HAMMER' || priceAction.candlestick === 'BULLISH_ENGULFING'
        : priceAction.candlestick === 'SHOOTING_STAR' || priceAction.candlestick === 'BEARISH_ENGULFING',
    );
    check(
      bullish ? 'VWAP reclaim print (or still below waiting reclaim)' : 'VWAP rejection print (or still above waiting rejection)',
      bullish
        ? volume.vwap.event === 'RECLAIM' || extendedDown
        : volume.vwap.event === 'REJECTION' || extendedUp,
    );

    if (bullish && regime.regime === 'BEARISH_TREND') {
      contradictions.push('Fading a VWAP extension against BEARISH_TREND — mean reversion is not a trend-kill.');
    }
    if (!bullish && regime.regime === 'BULLISH_TREND') {
      contradictions.push('Fading a VWAP extension against BULLISH_TREND — mean reversion is not a trend-kill.');
    }

    const totalConditions = conditionsMet.length + conditionsFailed.length;
    const setupScore = scoreFromConditions(conditionsMet, totalConditions);
    const vwap = volume.vwap.vwap;
    const atr = volatility.atr;

    return {
      strategy: 'VWAP_MEAN_REVERSION',
      side,
      setupScore,
      confidence: setupScore / 100,
      conditionsMet,
      conditionsFailed,
      contradictions,
      invalidationConditions: [
        'Market structure trend flips against the fade.',
        `ADX rises through ${t.adxRangeMax} (range thesis gone).`,
      ],
      stop: atr
        ? { price: currentPrice + (bullish ? -atr : atr), basis: '1x ATR beyond the extended print.' }
        : { price: supportResistance.nearest.nearestSupport?.level ?? null, basis: 'No ATR; nearest structural level if present.' },
      target: vwap !== null
        ? { price: vwap, basis: 'Session VWAP (the mean being reverted to).' }
        : { price: null, basis: 'No session VWAP available.' },
      applicableRegimes: vwapMeanReversion.applicableRegimes,
    };
  },
};
