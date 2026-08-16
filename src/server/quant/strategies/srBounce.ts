/**
 * ==========================================================
 * Module: strategies/srBounce
 *
 * Purpose:
 * Experimental: bounce at nearest swing/pivot/previous-day S/R with a reversal candle.
 * Distinct from RANGE_REVERSION (does not require consolidating + no-spike).
 *
 * Live vs backtest:
 *   findStrategy() without the live flag; evaluateAll() only if QUANT_SR_BOUNCE_ENABLED=true.
 *
 * Status: UNVALIDATED. BacktestEngine is long-only.
 * ==========================================================
 */
import { StrategyContext, StrategyDefinition, StrategyEvaluation, scoreFromConditions } from './types';
import { quantExperimentalStrategies } from '../../config/quantExperimentalStrategies';

const t = quantExperimentalStrategies.thresholds;

export const srBounce: StrategyDefinition = {
  id: 'SR_BOUNCE',
  displayName: 'Support / Resistance Bounce',
  applicableRegimes: ['SIDEWAYS_RANGE', 'BULLISH_TREND', 'BEARISH_TREND'],

  evaluate(ctx: StrategyContext): StrategyEvaluation {
    const { supportResistance, priceAction, volume, volatility, currentPrice } = ctx;
    const support = supportResistance.nearest.nearestSupport;
    const resistance = supportResistance.nearest.nearestResistance;
    const supportDist = support !== null ? Math.abs(support.pct) : Infinity;
    const resistanceDist = resistance !== null ? Math.abs(resistance.pct) : Infinity;
    const bullish = supportDist <= resistanceDist;
    const side: 'BUY' | 'SELL' = bullish ? 'BUY' : 'SELL';
    const near = bullish ? support : resistance;
    const far = bullish ? resistance : support;

    const conditionsMet: string[] = [];
    const conditionsFailed: string[] = [];
    const contradictions: string[] = [];
    const check = (name: string, met: boolean) => (met ? conditionsMet.push(name) : conditionsFailed.push(name));

    check('Nearest support and/or resistance exists', near !== null);
    check(
      `Price within ${t.nearLevelPct}% of the nearer boundary`,
      near !== null && Math.abs(near.pct) <= t.nearLevelPct,
    );
    check(
      bullish ? 'Bullish reversal candle' : 'Bearish reversal candle',
      bullish
        ? priceAction.candlestick === 'HAMMER' || priceAction.candlestick === 'BULLISH_ENGULFING'
        : priceAction.candlestick === 'SHOOTING_STAR' || priceAction.candlestick === 'BEARISH_ENGULFING',
    );
    check(
      'Not a volume-spike breakout (RVOL below breakout threshold)',
      volume.relativeVolume !== null && volume.relativeVolume < t.rvolBreakout,
    );

    const totalConditions = conditionsMet.length + conditionsFailed.length;
    const setupScore = scoreFromConditions(conditionsMet, totalConditions);
    const atr = volatility.atr;

    return {
      strategy: 'SR_BOUNCE',
      side,
      setupScore,
      confidence: setupScore / 100,
      conditionsMet,
      conditionsFailed,
      contradictions,
      invalidationConditions: [
        'Price closes through the bounced level (flip to breakout, not bounce).',
      ],
      stop: near !== null && atr
        ? { price: bullish ? near.level - atr : near.level + atr, basis: '1x ATR beyond the bounced level.' }
        : { price: near?.level ?? null, basis: 'Bounced level if present; otherwise no stop.' },
      target: far
        ? { price: far.level, basis: 'Opposite S/R boundary.' }
        : atr
        ? { price: currentPrice + (bullish ? 2 * atr : -2 * atr), basis: '2x ATR (no opposite S/R).' }
        : { price: null, basis: 'No opposite S/R or ATR for a target.' },
      applicableRegimes: srBounce.applicableRegimes,
    };
  },
};
