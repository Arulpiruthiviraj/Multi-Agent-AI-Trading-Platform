/**
 * ==========================================================
 * Module: strategies/vwapVolumeStructure
 *
 * Purpose:
 * Experimental: established structure + price on the correct side of session VWAP + pullback
 * toward VWAP (small |distancePct|) + RVOL + reversal candle + ADX. Reads existing
 * volume.vwap / trend.structure — does not recompute VWAP.
 *
 * Live vs backtest:
 *   EXPERIMENTAL_STRATEGIES — findStrategy() can backtest without the live flag.
 *   evaluateAll() includes it only when QUANT_VWAP_STRUCTURE_ENABLED=true (config JSON).
 *
 * Status: UNVALIDATED.
 * ==========================================================
 */
import { StrategyContext, StrategyDefinition, StrategyEvaluation, scoreFromConditions } from './types';
import { quantExperimentalStrategies } from '../../config/quantExperimentalStrategies';

const t = quantExperimentalStrategies.thresholds;

export const vwapVolumeStructure: StrategyDefinition = {
  id: 'VWAP_VOLUME_STRUCTURE',
  displayName: 'VWAP Volume Structure',
  applicableRegimes: ['BULLISH_TREND', 'BEARISH_TREND'],

  evaluate(ctx: StrategyContext): StrategyEvaluation {
    const { trend, volume, priceAction, supportResistance, regime, volatility, currentPrice } = ctx;
    const bullish = trend.structure.trend === 'UPTREND' || (trend.structure.trend !== 'DOWNTREND' && regime.regime === 'BULLISH_TREND');
    const side: 'BUY' | 'SELL' = bullish ? 'BUY' : 'SELL';

    const conditionsMet: string[] = [];
    const conditionsFailed: string[] = [];
    const contradictions: string[] = [];
    const check = (name: string, met: boolean) => (met ? conditionsMet.push(name) : conditionsFailed.push(name));

    const dist = volume.vwap.distancePct;
    const absDist = dist !== null ? Math.abs(dist) : null;

    check(
      bullish ? 'Established uptrend (market structure)' : 'Established downtrend (market structure)',
      bullish ? trend.structure.trend === 'UPTREND' : trend.structure.trend === 'DOWNTREND',
    );
    check(
      bullish ? 'Price at or above session VWAP' : 'Price at or below session VWAP',
      dist !== null && (bullish ? dist >= 0 : dist <= 0),
    );
    check(
      `Pullback toward VWAP (|distancePct| <= ${t.vwapPullbackMaxDistancePct})`,
      absDist !== null && absDist <= t.vwapPullbackMaxDistancePct,
    );
    check(
      `RVOL confirmation (>= ${t.rvolContinuation}x)`,
      volume.relativeVolume !== null && volume.relativeVolume >= t.rvolContinuation,
    );
    check(
      `ADX trend strength (>= ${t.adxTrendMin})`,
      // Real bug found and fixed this pass: trend.dmi is DMIResult | null - guard it before .adx.
      trend.dmi !== null && trend.dmi.adx !== null && trend.dmi.adx >= t.adxTrendMin,
    );
    check(
      bullish ? 'Bullish rejection candle (hammer / engulfing)' : 'Bearish rejection candle (shooting star / engulfing)',
      bullish
        ? priceAction.candlestick === 'HAMMER' || priceAction.candlestick === 'BULLISH_ENGULFING'
        : priceAction.candlestick === 'SHOOTING_STAR' || priceAction.candlestick === 'BEARISH_ENGULFING',
    );

    if (bullish && volume.vwap.event === 'REJECTION') {
      contradictions.push('VWAP REJECTION event while scoring a long pullback — structure may already be failing.');
    }
    if (!bullish && volume.vwap.event === 'RECLAIM') {
      contradictions.push('VWAP RECLAIM event while scoring a short pullback — structure may already be failing.');
    }

    const totalConditions = conditionsMet.length + conditionsFailed.length;
    const setupScore = scoreFromConditions(conditionsMet, totalConditions);
    const atr = volatility.atr;
    const vwap = volume.vwap.vwap;

    return {
      strategy: 'VWAP_VOLUME_STRUCTURE',
      side,
      setupScore,
      confidence: setupScore / 100,
      conditionsMet,
      conditionsFailed,
      contradictions,
      invalidationConditions: [
        'Close through session VWAP against the trade.',
        'Market structure CHoCH against the side.',
        `RVOL collapses below follow-through (${t.rvolContinuation}x).`,
      ],
      stop: atr && vwap !== null
        ? {
            price: bullish ? Math.min(vwap, currentPrice) - atr : Math.max(vwap, currentPrice) + atr,
            basis: '1x ATR beyond the nearer of VWAP and current price.',
          }
        : { price: supportResistance.nearest.nearestSupport?.level ?? null, basis: 'No ATR/VWAP for a measured stop; nearest structural level if present.' },
      target: atr
        ? { price: currentPrice + (bullish ? 2 * atr : -2 * atr), basis: '2x ATR measured move from current price (no invented VWAP band).' }
        : { price: null, basis: 'No ATR available for a measured target.' },
      applicableRegimes: vwapVolumeStructure.applicableRegimes,
    };
  },
};
