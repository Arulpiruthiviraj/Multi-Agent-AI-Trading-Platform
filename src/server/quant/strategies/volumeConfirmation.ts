/**
 * ==========================================================
 * Module: strategies/volumeConfirmation
 *
 * Purpose:
 * Experimental: RVOL spike + CMF/MFI alignment with market structure. Volume profile / POC / HVN
 * are NOT_SUPPORTED in QuantitativeFeatureEngine and are not used here.
 *
 * Live vs backtest:
 *   findStrategy() without the live flag; evaluateAll() only if QUANT_VOLUME_CONFIRMATION_ENABLED=true.
 *
 * Status: UNVALIDATED. BacktestEngine is long-only.
 * ==========================================================
 */
import { StrategyContext, StrategyDefinition, StrategyEvaluation, scoreFromConditions } from './types';
import { quantExperimentalStrategies } from '../../config/quantExperimentalStrategies';

const t = quantExperimentalStrategies.thresholds;

export const volumeConfirmation: StrategyDefinition = {
  id: 'VOLUME_CONFIRMATION',
  displayName: 'Volume Confirmation',
  applicableRegimes: ['BULLISH_TREND', 'BEARISH_TREND'],

  evaluate(ctx: StrategyContext): StrategyEvaluation {
    const { volume, trend, volatility, regime, currentPrice } = ctx;
    const bullish = (volume.cmf ?? 0) >= 0 && trend.structure.event !== 'BOS_BEARISH';
    const side: 'BUY' | 'SELL' = bullish ? 'BUY' : 'SELL';

    const conditionsMet: string[] = [];
    const conditionsFailed: string[] = [];
    const contradictions: string[] = [];
    const check = (name: string, met: boolean) => (met ? conditionsMet.push(name) : conditionsFailed.push(name));

    check(
      `RVOL spike (>= ${t.rvolBreakout}x) or isSpike flag`,
      volume.isSpike === true || (volume.relativeVolume !== null && volume.relativeVolume >= t.rvolBreakout),
    );
    check(
      bullish ? 'Chaikin Money Flow >= 0' : 'Chaikin Money Flow < 0',
      volume.cmf !== null && (bullish ? volume.cmf >= 0 : volume.cmf < 0),
    );
    check(
      bullish ? 'MFI > 50' : 'MFI < 50',
      volume.mfi !== null && (bullish ? volume.mfi > 50 : volume.mfi < 50),
    );
    check(
      bullish ? 'Structure not printing BOS_BEARISH' : 'Structure not printing BOS_BULLISH',
      bullish ? trend.structure.event !== 'BOS_BEARISH' : trend.structure.event !== 'BOS_BULLISH',
    );
    check(
      'Favorable market regime',
      bullish ? regime.regime === 'BULLISH_TREND' : regime.regime === 'BEARISH_TREND',
    );

    const totalConditions = conditionsMet.length + conditionsFailed.length;
    const setupScore = scoreFromConditions(conditionsMet, totalConditions);
    const atr = volatility.atr;

    return {
      strategy: 'VOLUME_CONFIRMATION',
      side,
      setupScore,
      confidence: setupScore / 100,
      conditionsMet,
      conditionsFailed,
      contradictions,
      invalidationConditions: [
        'RVOL collapses and CMF flips against the side.',
        'Structure prints BOS against the position.',
      ],
      stop: atr
        ? { price: currentPrice + (bullish ? -atr : atr), basis: '1x ATR from current price.' }
        : { price: null, basis: 'No ATR for a stop.' },
      target: atr
        ? { price: currentPrice + (bullish ? 2 * atr : -2 * atr), basis: '2x ATR measured move.' }
        : { price: null, basis: 'No ATR for a measured target.' },
      applicableRegimes: volumeConfirmation.applicableRegimes,
    };
  },
};
