/**
 * ==========================================================
 * Module: strategies/candlestickReversal
 *
 * Purpose:
 * Experimental: the candlestick patterns PriceActionFeatures actually detects (doji, hammer,
 * shooting star, engulfing) at nearest S/R. Other named candles (morning star, three soldiers,
 * harami, …) are aliases in the taxonomy, not extra detectors.
 *
 * Live vs backtest:
 *   findStrategy() without the live flag; evaluateAll() only if QUANT_CANDLESTICK_REVERSAL_ENABLED=true.
 *
 * Status: UNVALIDATED. BacktestEngine is long-only.
 * ==========================================================
 */
import { StrategyContext, StrategyDefinition, StrategyEvaluation, scoreFromConditions } from './types';
import { quantExperimentalStrategies } from '../../config/quantExperimentalStrategies';

const t = quantExperimentalStrategies.thresholds;
const BULLISH_CANDLES = new Set(['HAMMER', 'BULLISH_ENGULFING', 'DOJI']);
const BEARISH_CANDLES = new Set(['SHOOTING_STAR', 'BEARISH_ENGULFING', 'DOJI']);

export const candlestickReversal: StrategyDefinition = {
  id: 'CANDLESTICK_REVERSAL',
  displayName: 'Candlestick Reversal',
  applicableRegimes: ['SIDEWAYS_RANGE', 'BULLISH_TREND', 'BEARISH_TREND'],

  evaluate(ctx: StrategyContext): StrategyEvaluation {
    const { priceAction, supportResistance, momentum, volatility, currentPrice } = ctx;
    const candle = priceAction.candlestick;
    const support = supportResistance.nearest.nearestSupport;
    const resistance = supportResistance.nearest.nearestResistance;
    const nearSupport = support !== null && Math.abs(support.pct) <= t.nearLevelPct;
    const nearResistance = resistance !== null && Math.abs(resistance.pct) <= t.nearLevelPct;
    const bullishCandle = candle !== null && BULLISH_CANDLES.has(candle) && candle !== 'SHOOTING_STAR';
    const bearishCandle = candle !== null && BEARISH_CANDLES.has(candle) && candle !== 'HAMMER';
    const side: 'BUY' | 'SELL' = (bearishCandle && nearResistance && !nearSupport) || (bearishCandle && !bullishCandle)
      ? 'SELL'
      : 'BUY';
    const bullish = side === 'BUY';

    const conditionsMet: string[] = [];
    const conditionsFailed: string[] = [];
    const contradictions: string[] = [];
    const check = (name: string, met: boolean) => (met ? conditionsMet.push(name) : conditionsFailed.push(name));

    check('A detected candlestick pattern is present', candle !== null);
    check(
      bullish ? 'Bullish reversal candle (hammer/engulfing/doji)' : 'Bearish reversal candle (shooting-star/engulfing/doji)',
      bullish ? bullishCandle : bearishCandle,
    );
    check(
      bullish ? `Near support (within ${t.nearLevelPct}%)` : `Near resistance (within ${t.nearLevelPct}%)`,
      bullish ? nearSupport : nearResistance,
    );
    check(
      bullish ? 'RSI not already overbought' : 'RSI not already oversold',
      bullish ? momentum.rsi < 70 : momentum.rsi > 30,
    );

    if (candle === null) {
      contradictions.push('No matching 1–2 bar pattern in PriceActionFeatures — other named candles are not separately detected.');
    }

    const totalConditions = conditionsMet.length + conditionsFailed.length;
    const setupScore = scoreFromConditions(conditionsMet, totalConditions);
    const atr = volatility.atr;
    const level = bullish ? support?.level ?? null : resistance?.level ?? null;

    return {
      strategy: 'CANDLESTICK_REVERSAL',
      side,
      setupScore,
      confidence: setupScore / 100,
      conditionsMet,
      conditionsFailed,
      contradictions,
      invalidationConditions: [
        `Price closes through the ${bullish ? 'support' : 'resistance'} reference (failed reversal).`,
      ],
      stop: level !== null && atr
        ? { price: bullish ? level - atr : level + atr, basis: '1x ATR beyond the S/R reference.' }
        : { price: level, basis: 'S/R reference if present; otherwise no stop.' },
      target: atr
        ? { price: currentPrice + (bullish ? 2 * atr : -2 * atr), basis: '2x ATR measured move.' }
        : { price: null, basis: 'No ATR for a measured target.' },
      applicableRegimes: candlestickReversal.applicableRegimes,
    };
  },
};
