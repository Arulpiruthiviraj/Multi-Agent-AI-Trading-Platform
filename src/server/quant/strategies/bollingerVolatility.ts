/**
 * ==========================================================
 * Module: strategies/bollingerVolatility
 *
 * Purpose:
 * Experimental volatility-band family: squeeze (narrow BB width + CONTRACTING) or expansion
 * breakout (EXPANDING + price outside Keltner). VolatilityFeatures expose BB width%, not raw
 * band prices — Keltner is the real price band used for the break.
 *
 * Live vs backtest:
 *   findStrategy() without the live flag; evaluateAll() only if QUANT_BOLLINGER_VOLATILITY_ENABLED=true.
 *
 * Status: UNVALIDATED. BacktestEngine is long-only.
 * ==========================================================
 */
import { StrategyContext, StrategyDefinition, StrategyEvaluation, scoreFromConditions } from './types';
import { quantExperimentalStrategies } from '../../config/quantExperimentalStrategies';

const t = quantExperimentalStrategies.thresholds;

export const bollingerVolatility: StrategyDefinition = {
  id: 'BOLLINGER_VOLATILITY',
  displayName: 'Bollinger / Volatility Breakout',
  applicableRegimes: ['BULLISH_TREND', 'BEARISH_TREND', 'SIDEWAYS_RANGE'],

  evaluate(ctx: StrategyContext): StrategyEvaluation {
    const { volatility, volume, priceAction, trend, currentPrice } = ctx;
    const keltner = volatility.keltner;
    const aboveUpper = keltner !== null && currentPrice > keltner.upper;
    const belowLower = keltner !== null && currentPrice < keltner.lower;
    const side: 'BUY' | 'SELL' = belowLower && !aboveUpper ? 'SELL' : 'BUY';
    const bullish = side === 'BUY';

    const conditionsMet: string[] = [];
    const conditionsFailed: string[] = [];
    const contradictions: string[] = [];
    const check = (name: string, met: boolean) => (met ? conditionsMet.push(name) : conditionsFailed.push(name));

    check(
      bullish ? 'Price above upper Keltner (expansion break)' : 'Price below lower Keltner (expansion break)',
      bullish ? aboveUpper : belowLower,
    );
    check('Volatility regime EXPANDING on the break', volatility.regime === 'EXPANDING');
    check(
      'Bollinger width available (squeeze is prior-bar state; not required on the same print as EXPANDING)',
      volatility.bollingerBandWidthPct !== null,
    );
    check(
      `RVOL confirmation (>= ${t.rvolContinuation}x)`,
      volume.relativeVolume !== null && volume.relativeVolume >= t.rvolContinuation,
    );
    check(
      `ADX trend strength (>= ${t.adxTrendMin})`,
      trend.dmi.adx !== null && trend.dmi.adx >= t.adxTrendMin,
    );

    if (priceAction.consolidating && volatility.regime === 'EXPANDING') {
      contradictions.push('Still consolidating while volatility regime is EXPANDING — expansion break is weaker.');
    }

    const totalConditions = conditionsMet.length + conditionsFailed.length;
    const setupScore = scoreFromConditions(conditionsMet, totalConditions);
    const atr = volatility.atr;
    const band = keltner ? (bullish ? keltner.upper : keltner.lower) : null;

    return {
      strategy: 'BOLLINGER_VOLATILITY',
      side,
      setupScore,
      confidence: setupScore / 100,
      conditionsMet,
      conditionsFailed,
      contradictions,
      invalidationConditions: [
        'Price closes back inside the Keltner channel (failed expansion).',
        'Volatility regime returns to CONTRACTING without follow-through.',
      ],
      stop: band !== null && atr
        ? { price: bullish ? band - atr : band + atr, basis: '1x ATR beyond the broken Keltner band.' }
        : { price: band, basis: 'Keltner band if present; otherwise no stop.' },
      target: atr
        ? { price: currentPrice + (bullish ? 2 * atr : -2 * atr), basis: '2x ATR measured move.' }
        : { price: null, basis: 'No ATR for a measured target.' },
      applicableRegimes: bollingerVolatility.applicableRegimes,
    };
  },
};
