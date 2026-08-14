/**
 * ==========================================================
 * Module: strategies/momentumBreakout
 *
 * Purpose:
 * Phase 4 - Momentum Breakout strategy, matching the user's own worked example: a real structural
 * break (BOS) confirmed by RVOL, ATR expansion, VWAP position, market regime, sector regime, and
 * relative strength. Bidirectional: a bullish breakout (BOS_BULLISH) sets up a BUY, a bearish
 * breakdown (BOS_BEARISH) sets up a SELL - same real conditions, mirrored.
 *
 * Every condition reads an already-computed Phase 1-3 feature (never re-derives indicator math,
 * never touches raw bars) - `trend.structure.event` (from RegimeEngine's own trend features) is
 * the real "resistance/support broken" signal, since it already requires a real close beyond the
 * last swing point (see indicators/trend.ts's detectMarketStructure).
 * ==========================================================
 */
import { StrategyContext, StrategyDefinition, StrategyEvaluation, scoreFromConditions } from './types';

const RVOL_THRESHOLD = 1.5;

export const momentumBreakout: StrategyDefinition = {
  id: 'MOMENTUM_BREAKOUT',
  displayName: 'Momentum Breakout',
  applicableRegimes: ['BULLISH_TREND', 'BEARISH_TREND'],

  evaluate(ctx: StrategyContext): StrategyEvaluation {
    const { trend, momentum, volatility, volume, priceAction, supportResistance, regime, marketContext } = ctx;

    // The real structural break is what determines direction - no break, no breakout setup.
    const bullBreak = trend.structure.event === 'BOS_BULLISH';
    const bearBreak = trend.structure.event === 'BOS_BEARISH';
    const side: 'BUY' | 'SELL' = bearBreak && !bullBreak ? 'SELL' : 'BUY';
    const bullish = side === 'BUY';

    const conditionsMet: string[] = [];
    const conditionsFailed: string[] = [];
    const contradictions: string[] = [];

    const check = (name: string, met: boolean) => (met ? conditionsMet.push(name) : conditionsFailed.push(name));

    check('Structural break in trade direction (BOS)', bullish ? bullBreak : bearBreak);
    check('RVOL confirmation (>=1.5x average volume)', volume.relativeVolume !== null && volume.relativeVolume >= RVOL_THRESHOLD);
    check('ATR expansion (volatility regime EXPANDING)', volatility.regime === 'EXPANDING');
    check(
      bullish ? 'Price above session VWAP' : 'Price below session VWAP',
      volume.vwap.distancePct !== null && (bullish ? volume.vwap.distancePct > 0 : volume.vwap.distancePct < 0)
    );
    check('Favorable market regime', bullish ? regime.regime === 'BULLISH_TREND' : regime.regime === 'BEARISH_TREND');
    check(
      'Favorable sector regime',
      marketContext.sector.trend?.regime !== null &&
        marketContext.sector.trend?.regime !== undefined &&
        (bullish ? marketContext.sector.trend.regime.regime === 'BULLISH_TREND' : marketContext.sector.trend.regime.regime === 'BEARISH_TREND')
    );
    check(
      bullish ? 'Positive relative strength vs SPY' : 'Negative relative strength vs SPY',
      marketContext.relativeStrengthVsSPY?.relativeStrengthPct !== null &&
        marketContext.relativeStrengthVsSPY?.relativeStrengthPct !== undefined &&
        (bullish ? marketContext.relativeStrengthVsSPY.relativeStrengthPct > 0 : marketContext.relativeStrengthVsSPY.relativeStrengthPct < 0)
    );
    check(
      bullish ? 'Positive momentum (ROC > 0)' : 'Negative momentum (ROC < 0)',
      momentum.roc !== null && (bullish ? momentum.roc > 0 : momentum.roc < 0)
    );

    // Real internal conflicts - distinct from a condition simply not being met.
    if (bullish && momentum.rsi >= 80) {
      contradictions.push('RSI already extremely overbought (>=80) on a fresh bullish breakout - elevated risk of immediate failure/exhaustion.');
    }
    if (!bullish && momentum.rsi <= 20) {
      contradictions.push('RSI already extremely oversold (<=20) on a fresh bearish breakdown - elevated risk of immediate failure/exhaustion.');
    }
    if (bullish && priceAction.candlestick === 'SHOOTING_STAR') {
      contradictions.push('Most recent candle is a SHOOTING_STAR despite a bullish breakout signal.');
    }
    if (!bullish && priceAction.candlestick === 'HAMMER') {
      contradictions.push('Most recent candle is a HAMMER despite a bearish breakdown signal.');
    }

    const totalConditions = conditionsMet.length + conditionsFailed.length;
    const setupScore = scoreFromConditions(conditionsMet, totalConditions);

    const brokenLevel = bullish ? trend.structure.lastSwingHigh : trend.structure.lastSwingLow;
    const nearestBeyond = bullish ? supportResistance.nearest.nearestResistance : supportResistance.nearest.nearestSupport;
    const atr = volatility.atr;

    return {
      strategy: 'MOMENTUM_BREAKOUT',
      side,
      setupScore,
      confidence: setupScore / 100,
      conditionsMet,
      conditionsFailed,
      contradictions,
      invalidationConditions: [
        `Price closes back ${bullish ? 'below' : 'above'} the broken level (false breakout).`,
        'RVOL drops back below 1.2x average on the follow-through bar(s).',
        `Market regime flips away from ${bullish ? 'BULLISH_TREND' : 'BEARISH_TREND'}.`,
      ],
      stop: brokenLevel !== null && atr
        ? { price: bullish ? brokenLevel - atr : brokenLevel + atr, basis: `1x ATR ${bullish ? 'below' : 'above'} the broken structural level (${brokenLevel.toFixed(2)}).` }
        : { price: null, basis: 'No real broken structural level or ATR available yet to derive a stop.' },
      target: nearestBeyond
        ? { price: nearestBeyond.level, basis: `Next real ${bullish ? 'resistance' : 'support'} level beyond the breakout.` }
        : atr
        ? { price: ctx.currentPrice + (bullish ? 2 * atr : -2 * atr), basis: '2x ATR measured move (no further real S/R level available).' }
        : { price: null, basis: 'No further real level or ATR available yet to derive a target.' },
      applicableRegimes: momentumBreakout.applicableRegimes,
    };
  },
};
