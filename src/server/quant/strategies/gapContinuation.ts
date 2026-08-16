/**
 * ==========================================================
 * Module: strategies/gapContinuation
 *
 * Purpose:
 * Experimental: UTC-session gap vs prior close with RVOL and VWAP alignment (continuation).
 * Gap-fade / earnings-gap / news-gap are taxonomy aliases or NOT_SUPPORTED (no event calendar).
 *
 * Live vs backtest:
 *   findStrategy() without the live flag; evaluateAll() only if QUANT_GAP_STRATEGY_ENABLED=true.
 *
 * Status: UNVALIDATED. BacktestEngine is long-only.
 * ==========================================================
 */
import { StrategyContext, StrategyDefinition, StrategyEvaluation, scoreFromConditions } from './types';
import { quantExperimentalStrategies } from '../../config/quantExperimentalStrategies';

const t = quantExperimentalStrategies.thresholds;

export const gapContinuation: StrategyDefinition = {
  id: 'GAP_CONTINUATION',
  displayName: 'Gap Continuation',
  applicableRegimes: ['BULLISH_TREND', 'BEARISH_TREND'],

  evaluate(ctx: StrategyContext): StrategyEvaluation {
    const { priceAction, volume, volatility, regime, currentPrice } = ctx;
    const gapUp = priceAction.gap.type === 'GAP_UP';
    const gapDown = priceAction.gap.type === 'GAP_DOWN';
    const side: 'BUY' | 'SELL' = gapDown && !gapUp ? 'SELL' : 'BUY';
    const bullish = side === 'BUY';
    const sizeOk =
      priceAction.gap.sizePct !== null && Math.abs(priceAction.gap.sizePct) >= t.gapMinSizePct;

    const conditionsMet: string[] = [];
    const conditionsFailed: string[] = [];
    const contradictions: string[] = [];
    const check = (name: string, met: boolean) => (met ? conditionsMet.push(name) : conditionsFailed.push(name));

    check(bullish ? 'Gap up vs prior UTC-day close' : 'Gap down vs prior UTC-day close', bullish ? gapUp : gapDown);
    check(`Gap size >= ${t.gapMinSizePct}%`, sizeOk);
    check(
      `RVOL confirmation (>= ${t.rvolBreakout}x)`,
      volume.relativeVolume !== null && volume.relativeVolume >= t.rvolBreakout,
    );
    check(
      bullish ? 'Price above session VWAP' : 'Price below session VWAP',
      volume.vwap.distancePct !== null && (bullish ? volume.vwap.distancePct > 0 : volume.vwap.distancePct < 0),
    );
    check(
      'Favorable market regime',
      bullish ? regime.regime === 'BULLISH_TREND' : regime.regime === 'BEARISH_TREND',
    );

    if (priceAction.gap.type === null) {
      contradictions.push('No gap vs prior UTC-day close (threshold in detectGap) — not a fabricated earnings/news gap.');
    }

    const totalConditions = conditionsMet.length + conditionsFailed.length;
    const setupScore = scoreFromConditions(conditionsMet, totalConditions);
    const atr = volatility.atr;

    return {
      strategy: 'GAP_CONTINUATION',
      side,
      setupScore,
      confidence: setupScore / 100,
      conditionsMet,
      conditionsFailed,
      contradictions,
      invalidationConditions: [
        'Gap fills back through the prior close (continuation failed).',
        `RVOL collapses below ${t.rvolContinuation}x.`,
      ],
      stop: atr
        ? { price: currentPrice + (bullish ? -atr : atr), basis: '1x ATR from current price (gap fill is the thesis fail).' }
        : { price: null, basis: 'No ATR for a stop.' },
      target: atr
        ? { price: currentPrice + (bullish ? 2 * atr : -2 * atr), basis: '2x ATR measured move.' }
        : { price: null, basis: 'No ATR for a measured target.' },
      applicableRegimes: gapContinuation.applicableRegimes,
    };
  },
};
