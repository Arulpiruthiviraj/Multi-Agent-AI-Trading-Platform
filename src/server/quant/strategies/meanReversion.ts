/**
 * ==========================================================
 * Module: strategies/meanReversion
 *
 * Purpose:
 * Phase 4 - Mean Reversion: a real ranging/non-trending regime, RSI + Stochastic RSI both at a real
 * extreme, and price outside its Keltner Channel (the real, already-computed volatility band this
 * layer has - VolatilityFeatures does not expose raw Bollinger Band levels, only a width%, so the
 * Keltner Channel is used as the real "extended from the mean" band here). Targets a reversion back
 * to the channel's own middle line, not an arbitrary number.
 * ==========================================================
 */
import { StrategyContext, StrategyDefinition, StrategyEvaluation, scoreFromConditions } from './types';

const RSI_OVERSOLD = 30;
const RSI_OVERBOUGHT = 70;
const STOCH_RSI_OVERSOLD = 20;
const STOCH_RSI_OVERBOUGHT = 80;

export const meanReversion: StrategyDefinition = {
  id: 'MEAN_REVERSION',
  displayName: 'Mean Reversion',
  applicableRegimes: ['SIDEWAYS_RANGE'],

  evaluate(ctx: StrategyContext): StrategyEvaluation {
    const { momentum, volatility, volume, priceAction, supportResistance, regime, currentPrice } = ctx;

    // Direction picked from which real extreme is actually present; RSI < 50 defaults to a bullish
    // (oversold-fade) read when neither extreme is clearly hit, since that's this strategy's more
    // common real-world case (fading dips) and every condition below is scored honestly regardless.
    const oversold = momentum.rsi <= RSI_OVERSOLD;
    const overbought = momentum.rsi >= RSI_OVERBOUGHT;
    const bullish = overbought ? false : true;
    const side: 'BUY' | 'SELL' = bullish ? 'BUY' : 'SELL';

    const conditionsMet: string[] = [];
    const conditionsFailed: string[] = [];
    const contradictions: string[] = [];
    const check = (name: string, met: boolean) => (met ? conditionsMet.push(name) : conditionsFailed.push(name));

    check(
      'Ranging / non-trending regime (not a real directional trend)',
      regime.marketStructure === 'RANGING' || regime.regime === 'SIDEWAYS_RANGE'
    );
    check(bullish ? 'RSI oversold (<=30)' : 'RSI overbought (>=70)', bullish ? oversold : overbought);
    check(
      bullish ? 'Price at/below the lower Keltner Channel' : 'Price at/above the upper Keltner Channel',
      volatility.keltner !== null && (bullish ? currentPrice <= volatility.keltner.lower : currentPrice >= volatility.keltner.upper)
    );
    check(
      bullish ? 'Stochastic RSI confirming oversold (<=20)' : 'Stochastic RSI confirming overbought (>=80)',
      momentum.stochasticRSI !== null && (bullish ? momentum.stochasticRSI <= STOCH_RSI_OVERSOLD : momentum.stochasticRSI >= STOCH_RSI_OVERBOUGHT)
    );
    check(
      bullish ? 'Bullish reversal candlestick' : 'Bearish reversal candlestick',
      bullish
        ? priceAction.candlestick === 'HAMMER' || priceAction.candlestick === 'BULLISH_ENGULFING'
        : priceAction.candlestick === 'SHOOTING_STAR' || priceAction.candlestick === 'BEARISH_ENGULFING'
    );

    if (bullish && regime.regime === 'BEARISH_TREND') {
      contradictions.push('Regime is BEARISH_TREND, not ranging - fading an oversold reading against a real downtrend is a materially riskier trade.');
    }
    if (!bullish && regime.regime === 'BULLISH_TREND') {
      contradictions.push('Regime is BULLISH_TREND, not ranging - fading an overbought reading against a real uptrend is a materially riskier trade.');
    }

    const totalConditions = conditionsMet.length + conditionsFailed.length;
    const setupScore = scoreFromConditions(conditionsMet, totalConditions);

    const structuralStop = bullish ? supportResistance.nearest.nearestSupport : supportResistance.nearest.nearestResistance;
    const meanTarget = volatility.keltner?.middle ?? null;

    return {
      strategy: 'MEAN_REVERSION',
      side,
      setupScore,
      confidence: setupScore / 100,
      conditionsMet,
      conditionsFailed,
      contradictions,
      invalidationConditions: [
        `Price makes a real new ${bullish ? 'low' : 'high'} beyond the recent range (the range itself is breaking, not just reverting).`,
        `Market structure trend flips to a real ${bullish ? 'DOWNTREND' : 'UPTREND'}.`,
      ],
      stop: structuralStop
        ? { price: structuralStop.level, basis: `Nearest real ${bullish ? 'support' : 'resistance'} level - beyond it, the range is broken, not just reverting.` }
        : { price: null, basis: 'No real support/resistance level available yet to derive a stop.' },
      target: meanTarget !== null
        ? { price: meanTarget, basis: "Keltner Channel middle line (the statistical 'mean' being reverted to)." }
        : { price: null, basis: 'No real Keltner Channel available yet to derive a mean-reversion target.' },
      applicableRegimes: meanReversion.applicableRegimes,
    };
  },
};
