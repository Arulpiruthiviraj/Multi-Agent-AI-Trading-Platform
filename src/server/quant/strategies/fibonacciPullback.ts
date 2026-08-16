/**
 * ==========================================================
 * Module: strategies/fibonacciPullback
 *
 * Purpose:
 * Experimental: price near the 61.8% retracement of the trailing daily range, in the direction of
 * structure. Fibonacci time zones / arcs are not computed.
 *
 * Live vs backtest:
 *   findStrategy() without the live flag; evaluateAll() only if QUANT_FIBONACCI_PULLBACK_ENABLED=true.
 *
 * Status: UNVALIDATED. BacktestEngine is long-only.
 * ==========================================================
 */
import { StrategyContext, StrategyDefinition, StrategyEvaluation, scoreFromConditions } from './types';
import { quantExperimentalStrategies } from '../../config/quantExperimentalStrategies';

const t = quantExperimentalStrategies.thresholds;

export const fibonacciPullback: StrategyDefinition = {
  id: 'FIBONACCI_PULLBACK',
  displayName: 'Fibonacci Pullback',
  applicableRegimes: ['BULLISH_TREND', 'BEARISH_TREND'],

  evaluate(ctx: StrategyContext): StrategyEvaluation {
    const { supportResistance, trend, momentum, volume, volatility, regime, currentPrice } = ctx;
    const fib = supportResistance.fibonacci;
    const bullish = trend.structure.trend === 'UPTREND' || regime.regime === 'BULLISH_TREND';
    const side: 'BUY' | 'SELL' = bullish ? 'BUY' : 'SELL';
    const level618 = fib && typeof fib.level618 === 'number' ? fib.level618 : null;
    const near618 =
      level618 !== null &&
      level618 !== 0 &&
      Math.abs((currentPrice - level618) / level618) * 100 <= t.fibProximityPct;

    const conditionsMet: string[] = [];
    const conditionsFailed: string[] = [];
    const contradictions: string[] = [];
    const check = (name: string, met: boolean) => (met ? conditionsMet.push(name) : conditionsFailed.push(name));

    check('Fibonacci retracement of the trailing daily range is available', fib !== null && level618 !== null);
    check(`Price near 61.8% retracement (within ${t.fibProximityPct}%)`, near618);
    check(
      bullish ? 'Uptrend structure or bullish regime' : 'Downtrend structure or bearish regime',
      bullish
        ? trend.structure.trend === 'UPTREND' || regime.regime === 'BULLISH_TREND'
        : trend.structure.trend === 'DOWNTREND' || regime.regime === 'BEARISH_TREND',
    );
    check('RSI in a healthy (non-extreme) pullback zone', momentum.rsi >= 35 && momentum.rsi <= 65);
    check(
      'Volume not exploding (RVOL < breakout threshold — pullback, not a new breakout)',
      volume.relativeVolume !== null && volume.relativeVolume < t.rvolBreakout,
    );

    if (fib === null) {
      contradictions.push('No daily-range Fibonacci — not a fabricated 38.2/50/78.6 confluence stack.');
    }

    const totalConditions = conditionsMet.length + conditionsFailed.length;
    const setupScore = scoreFromConditions(conditionsMet, totalConditions);
    const atr = volatility.atr;

    return {
      strategy: 'FIBONACCI_PULLBACK',
      side,
      setupScore,
      confidence: setupScore / 100,
      conditionsMet,
      conditionsFailed,
      contradictions,
      invalidationConditions: [
        'Price closes through the 61.8% reference against the trend (retracement became a reversal).',
        'Market structure trend flips against the side.',
      ],
      stop: level618 !== null && atr
        ? { price: bullish ? level618 - atr : level618 + atr, basis: '1x ATR beyond the 61.8% retracement.' }
        : { price: level618, basis: '61.8% level if present; otherwise no stop.' },
      target: fib && typeof fib.level100 === 'number'
        ? { price: bullish ? fib.level100 : fib.level0, basis: 'Range extreme (Fib 0/100 of the trailing daily range).' }
        : { price: null, basis: 'No Fibonacci range extreme for a target.' },
      applicableRegimes: fibonacciPullback.applicableRegimes,
    };
  },
};
