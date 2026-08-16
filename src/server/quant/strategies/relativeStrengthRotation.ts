/**
 * ==========================================================
 * Module: strategies/relativeStrengthRotation
 *
 * Purpose:
 * Experimental: symbol vs SPY relative strength plus sector regime. Advance/decline, McClellan,
 * TRIN, % above MA remain NOT_SUPPORTED (QuantitativeFeatureEngine.marketBreadth).
 *
 * Live vs backtest:
 *   findStrategy() without the live flag; evaluateAll() only if QUANT_RELATIVE_STRENGTH_ENABLED=true.
 *
 * Status: UNVALIDATED. BacktestEngine is long-only.
 * ==========================================================
 */
import { StrategyContext, StrategyDefinition, StrategyEvaluation, scoreFromConditions } from './types';
import { quantExperimentalStrategies } from '../../config/quantExperimentalStrategies';

const t = quantExperimentalStrategies.thresholds;

export const relativeStrengthRotation: StrategyDefinition = {
  id: 'RELATIVE_STRENGTH_ROTATION',
  displayName: 'Relative Strength Rotation',
  applicableRegimes: ['BULLISH_TREND', 'BEARISH_TREND'],

  evaluate(ctx: StrategyContext): StrategyEvaluation {
    const { marketContext, trend, volatility, regime, currentPrice } = ctx;
    const rs = marketContext.relativeStrengthVsSPY?.relativeStrengthPct;
    const bullish = (rs ?? 0) >= 0 && regime.regime !== 'BEARISH_TREND';
    const side: 'BUY' | 'SELL' = bullish ? 'BUY' : 'SELL';

    const conditionsMet: string[] = [];
    const conditionsFailed: string[] = [];
    const contradictions: string[] = [];
    const check = (name: string, met: boolean) => (met ? conditionsMet.push(name) : conditionsFailed.push(name));

    check(
      'Relative strength vs SPY is available (not fabricated)',
      rs !== null && rs !== undefined,
    );
    check(
      bullish ? 'Positive relative strength vs SPY' : 'Negative relative strength vs SPY',
      rs !== null && rs !== undefined && (bullish ? rs > 0 : rs < 0),
    );
    check(
      'Favorable market regime',
      bullish ? regime.regime === 'BULLISH_TREND' : regime.regime === 'BEARISH_TREND',
    );
    check(
      'Favorable sector regime when a sector ETF trend exists',
      marketContext.sector.trend?.regime !== null &&
        marketContext.sector.trend?.regime !== undefined &&
        (bullish
          ? marketContext.sector.trend.regime.regime === 'BULLISH_TREND'
          : marketContext.sector.trend.regime.regime === 'BEARISH_TREND'),
    );
    check(
      `ADX trend strength (>= ${t.adxTrendMin})`,
      trend.dmi.adx !== null && trend.dmi.adx >= t.adxTrendMin,
    );

    if (marketContext.breadth?.available === false) {
      contradictions.push(marketContext.breadth.reason || 'Market breadth is NOT_SUPPORTED — this module does not invent A/D or TRIN.');
    }

    const totalConditions = conditionsMet.length + conditionsFailed.length;
    const setupScore = scoreFromConditions(conditionsMet, totalConditions);
    const atr = volatility.atr;

    return {
      strategy: 'RELATIVE_STRENGTH_ROTATION',
      side,
      setupScore,
      confidence: setupScore / 100,
      conditionsMet,
      conditionsFailed,
      contradictions,
      invalidationConditions: [
        'Relative strength vs SPY flips against the side.',
        'Sector regime flips against the side.',
      ],
      stop: atr
        ? { price: currentPrice + (bullish ? -atr : atr), basis: '1x ATR from current price.' }
        : { price: null, basis: 'No ATR for a stop.' },
      target: atr
        ? { price: currentPrice + (bullish ? 2 * atr : -2 * atr), basis: '2x ATR measured move.' }
        : { price: null, basis: 'No ATR for a measured target.' },
      applicableRegimes: relativeStrengthRotation.applicableRegimes,
    };
  },
};
