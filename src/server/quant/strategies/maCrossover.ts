/**
 * ==========================================================
 * Module: strategies/maCrossover
 *
 * Purpose:
 * Experimental MA-family: SMA50 vs SMA200 stack + EMA9/EMA20 alignment + ADX.
 * StrategyContext only has current MA values — this is a golden/death *stack*, not a
 * same-bar crossover event (prior MA snapshots are not in the feature set).
 *
 * Live vs backtest:
 *   findStrategy() without the live flag; evaluateAll() only if QUANT_MA_CROSSOVER_ENABLED=true.
 *
 * Status: UNVALIDATED. BacktestEngine is long-only.
 * ==========================================================
 */
import { StrategyContext, StrategyDefinition, StrategyEvaluation, scoreFromConditions } from './types';
import { quantExperimentalStrategies } from '../../config/quantExperimentalStrategies';

const t = quantExperimentalStrategies.thresholds;

export const maCrossover: StrategyDefinition = {
  id: 'MA_CROSSOVER',
  displayName: 'Moving-Average Crossover',
  applicableRegimes: ['BULLISH_TREND', 'BEARISH_TREND'],

  evaluate(ctx: StrategyContext): StrategyEvaluation {
    const { trend, volume, volatility, regime, currentPrice } = ctx;
    const ma = trend.movingAverages;
    const goldenStack = ma.sma50 !== null && ma.sma200 !== null && ma.sma50 > ma.sma200;
    const deathStack = ma.sma50 !== null && ma.sma200 !== null && ma.sma50 < ma.sma200;
    const side: 'BUY' | 'SELL' = deathStack && !goldenStack ? 'SELL' : 'BUY';
    const bullish = side === 'BUY';

    const conditionsMet: string[] = [];
    const conditionsFailed: string[] = [];
    const contradictions: string[] = [];
    const check = (name: string, met: boolean) => (met ? conditionsMet.push(name) : conditionsFailed.push(name));

    check('SMA50 and SMA200 available', ma.sma50 !== null && ma.sma200 !== null);
    check(
      bullish ? 'SMA50 above SMA200 (golden-cross stack)' : 'SMA50 below SMA200 (death-cross stack)',
      bullish ? goldenStack : deathStack,
    );
    check(
      bullish ? 'EMA9 above EMA20' : 'EMA9 below EMA20',
      ma.ema9 !== null && ma.ema20 !== null && (bullish ? ma.ema9 > ma.ema20 : ma.ema9 < ma.ema20),
    );
    check(
      bullish ? 'Price above SMA50' : 'Price below SMA50',
      ma.sma50 !== null && (bullish ? currentPrice > ma.sma50 : currentPrice < ma.sma50),
    );
    check(
      `ADX trend strength (>= ${t.adxTrendMin})`,
      trend.dmi.adx !== null && trend.dmi.adx >= t.adxTrendMin,
    );
    check(
      'Favorable market regime',
      bullish ? regime.regime === 'BULLISH_TREND' : regime.regime === 'BEARISH_TREND',
    );

    if (ma.sma50 === null || ma.sma200 === null) {
      contradictions.push('SMA50/SMA200 not computable on this history — not a fabricated crossover.');
    }

    const totalConditions = conditionsMet.length + conditionsFailed.length;
    const setupScore = scoreFromConditions(conditionsMet, totalConditions);
    const atr = volatility.atr;

    return {
      strategy: 'MA_CROSSOVER',
      side,
      setupScore,
      confidence: setupScore / 100,
      conditionsMet,
      conditionsFailed,
      contradictions,
      invalidationConditions: [
        'SMA50/SMA200 stack flips against the position.',
        `ADX fades below ${t.adxTrendMin}.`,
      ],
      stop: ma.sma50 !== null && atr
        ? { price: bullish ? ma.sma50 - atr : ma.sma50 + atr, basis: '1x ATR beyond SMA50.' }
        : { price: ma.sma50, basis: 'SMA50 if present; otherwise no stop.' },
      target: atr
        ? { price: currentPrice + (bullish ? 2 * atr : -2 * atr), basis: '2x ATR measured move; MA systems have no fixed target.' }
        : { price: null, basis: 'No ATR for a measured target.' },
      applicableRegimes: maCrossover.applicableRegimes,
    };
  },
};
