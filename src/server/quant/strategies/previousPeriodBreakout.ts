/**
 * ==========================================================
 * Module: strategies/previousPeriodBreakout
 *
 * Purpose:
 * Experimental: close beyond previous-day high/low with RVOL. Weekly high/low (when present) is
 * extra confirmation. Opening-range / premarket remain unavailable on daily bars.
 *
 * Live vs backtest:
 *   findStrategy() without the live flag; evaluateAll() only if QUANT_PREVIOUS_PERIOD_BREAKOUT_ENABLED=true.
 *
 * Status: UNVALIDATED. BacktestEngine is long-only.
 * ==========================================================
 */
import { StrategyContext, StrategyDefinition, StrategyEvaluation, scoreFromConditions } from './types';
import { quantExperimentalStrategies } from '../../config/quantExperimentalStrategies';

const t = quantExperimentalStrategies.thresholds;

export const previousPeriodBreakout: StrategyDefinition = {
  id: 'PREVIOUS_PERIOD_BREAKOUT',
  displayName: 'Previous-Period Breakout',
  applicableRegimes: ['BULLISH_TREND', 'BEARISH_TREND'],

  evaluate(ctx: StrategyContext): StrategyEvaluation {
    const { supportResistance, volume, volatility, regime, currentPrice } = ctx;
    const prev = supportResistance.previousDay;
    const brokeHigh = prev !== null && currentPrice > prev.high;
    const brokeLow = prev !== null && currentPrice < prev.low;
    const side: 'BUY' | 'SELL' = brokeLow && !brokeHigh ? 'SELL' : 'BUY';
    const bullish = side === 'BUY';

    const conditionsMet: string[] = [];
    const conditionsFailed: string[] = [];
    const contradictions: string[] = [];
    const check = (name: string, met: boolean) => (met ? conditionsMet.push(name) : conditionsFailed.push(name));

    check('Previous-day high/low available', prev !== null);
    check(
      bullish ? 'Close above previous-day high' : 'Close below previous-day low',
      bullish ? brokeHigh : brokeLow,
    );
    check(
      `RVOL confirmation (>= ${t.rvolBreakout}x)`,
      volume.relativeVolume !== null && volume.relativeVolume >= t.rvolBreakout,
    );
    check('ATR expansion (volatility regime EXPANDING)', volatility.regime === 'EXPANDING');
    check(
      'Favorable market regime',
      bullish ? regime.regime === 'BULLISH_TREND' : regime.regime === 'BEARISH_TREND',
    );

    if (prev === null) {
      contradictions.push('No completed prior UTC day in the bar set — not a fabricated PDH/PDL.');
    }

    const totalConditions = conditionsMet.length + conditionsFailed.length;
    const setupScore = scoreFromConditions(conditionsMet, totalConditions);
    const atr = volatility.atr;
    const level = prev ? (bullish ? prev.high : prev.low) : null;

    return {
      strategy: 'PREVIOUS_PERIOD_BREAKOUT',
      side,
      setupScore,
      confidence: setupScore / 100,
      conditionsMet,
      conditionsFailed,
      contradictions,
      invalidationConditions: [
        'Price closes back through the broken previous-day extreme (false breakout).',
        `RVOL collapses below ${t.rvolContinuation}x.`,
      ],
      stop: level !== null && atr
        ? { price: bullish ? level - atr : level + atr, basis: '1x ATR beyond the broken previous-day extreme.' }
        : { price: level, basis: 'Previous-day extreme if present; otherwise no stop.' },
      target: atr
        ? { price: currentPrice + (bullish ? 2 * atr : -2 * atr), basis: '2x ATR measured move.' }
        : { price: null, basis: 'No ATR for a measured target.' },
      applicableRegimes: previousPeriodBreakout.applicableRegimes,
    };
  },
};
