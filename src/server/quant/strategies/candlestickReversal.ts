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
// DOJI is deliberately NOT in either set: it's a directionally-neutral (indecisive) candle, not
// inherently bullish or bearish. Handled explicitly below via support/resistance proximity
// instead - real bug found and fixed this pass: DOJI used to be in BOTH sets unconditionally, so
// bullishCandle/bearishCandle were both true for a DOJI regardless of context, and a DOJI near
// resistance (a bearish setup) could still silently resolve to BUY whenever it also happened to
// sit near support (the SELL branch's `!nearSupport` guard failed), while still scoring
// "Bullish reversal candle present" as a passed condition - an internally inconsistent signal.
const BULLISH_CANDLES = new Set(['HAMMER', 'BULLISH_ENGULFING']);
const BEARISH_CANDLES = new Set(['SHOOTING_STAR', 'BEARISH_ENGULFING']);

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
    const isDoji = candle === 'DOJI';
    // A DOJI's direction is resolved purely by which level it sits nearest to: bearish at
    // resistance, bullish at support. If it's near both (or neither), it has no directional edge
    // from location alone and falls through to the default BUY branch below, same as before.
    const dojiBearish = isDoji && nearResistance && !nearSupport;
    const dojiBullish = isDoji && nearSupport && !nearResistance;
    const bullishCandle = (candle !== null && BULLISH_CANDLES.has(candle)) || dojiBullish;
    const bearishCandle = (candle !== null && BEARISH_CANDLES.has(candle)) || dojiBearish;
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
