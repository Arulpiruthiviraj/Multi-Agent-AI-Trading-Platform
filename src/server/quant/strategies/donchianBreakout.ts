/**
 * ==========================================================
 * Module: strategies/donchianBreakout
 *
 * Purpose:
 * Experimental: close beyond the prior N-bar high/low (current bar excluded) with ADX and RVOL.
 * N = config donchianPriorLookback. Uses SupportResistanceFeatures.priorChannel20 — not a second
 * Donchian library. dailyHighLow includes the current bar so it cannot detect a break by itself.
 *
 * Live vs backtest:
 *   findStrategy() without the live flag; evaluateAll() only if QUANT_DONCHIAN_STRATEGY_ENABLED=true.
 *
 * Status: UNVALIDATED. BacktestEngine is long-only.
 * ==========================================================
 */
import { StrategyContext, StrategyDefinition, StrategyEvaluation, scoreFromConditions } from './types';
import { quantExperimentalStrategies } from '../../config/quantExperimentalStrategies';

const t = quantExperimentalStrategies.thresholds;

export const donchianBreakout: StrategyDefinition = {
  id: 'DONCHIAN_CHANNEL_BREAKOUT',
  displayName: 'Donchian Channel Breakout',
  applicableRegimes: ['BULLISH_TREND', 'BEARISH_TREND'],

  evaluate(ctx: StrategyContext): StrategyEvaluation {
    const { supportResistance, trend, volume, volatility, regime, currentPrice } = ctx;
    const channel = supportResistance.priorChannel20;
    const brokeHigh = channel !== null && currentPrice > channel.high;
    const brokeLow = channel !== null && currentPrice < channel.low;
    const side: 'BUY' | 'SELL' = brokeLow && !brokeHigh ? 'SELL' : 'BUY';
    const bullish = side === 'BUY';

    const conditionsMet: string[] = [];
    const conditionsFailed: string[] = [];
    const contradictions: string[] = [];
    const check = (name: string, met: boolean) => (met ? conditionsMet.push(name) : conditionsFailed.push(name));

    check(
      `Prior ${t.donchianPriorLookback}-bar channel available (current bar excluded)`,
      channel !== null,
    );
    check(
      bullish ? 'Close above prior-channel high' : 'Close below prior-channel low',
      bullish ? brokeHigh : brokeLow,
    );
    check(
      `ADX trend strength (>= ${t.adxTrendMin})`,
      trend.dmi.adx !== null && trend.dmi.adx >= t.adxTrendMin,
    );
    check(
      `RVOL confirmation (>= ${t.rvolContinuation}x)`,
      volume.relativeVolume !== null && volume.relativeVolume >= t.rvolContinuation,
    );
    check(
      'Favorable market regime',
      bullish ? regime.regime === 'BULLISH_TREND' : regime.regime === 'BEARISH_TREND',
    );
    check(
      'ATR expansion (volatility regime EXPANDING)',
      volatility.regime === 'EXPANDING',
    );

    if (channel === null) {
      contradictions.push(`No prior ${t.donchianPriorLookback}-bar channel — not enough bars excluding the current print.`);
    }

    const totalConditions = conditionsMet.length + conditionsFailed.length;
    const setupScore = scoreFromConditions(conditionsMet, totalConditions);
    const atr = volatility.atr;
    const extreme = channel ? (bullish ? channel.high : channel.low) : null;

    return {
      strategy: 'DONCHIAN_CHANNEL_BREAKOUT',
      side,
      setupScore,
      confidence: setupScore / 100,
      conditionsMet,
      conditionsFailed,
      contradictions,
      invalidationConditions: [
        'Price closes back through the broken channel extreme (false breakout).',
        `ADX fades below ${t.adxTrendMin}.`,
      ],
      stop: extreme !== null && atr
        ? { price: bullish ? extreme - atr : extreme + atr, basis: '1x ATR beyond the broken prior-channel extreme.' }
        : { price: extreme, basis: 'Channel extreme if present; otherwise no stop.' },
      target: atr
        ? { price: currentPrice + (bullish ? 2 * atr : -2 * atr), basis: '2x ATR measured move.' }
        : { price: null, basis: 'No ATR for a measured target.' },
      applicableRegimes: donchianBreakout.applicableRegimes,
    };
  },
};
