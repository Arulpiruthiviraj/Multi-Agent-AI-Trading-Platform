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
    const rsNum: number | null = rs ?? null;
    // Never default bullish on missing data: a null RS previously coerced to 0 (non-negative)
    // and the strategy emitted BUY ideas with its namesake input entirely absent.
    const bullish = rsNum !== null && rsNum >= 0 && regime.regime !== 'BEARISH_TREND';
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
      // Real bug found and fixed this pass: trend.dmi is DMIResult | null - guard it before .adx.
      trend.dmi !== null && trend.dmi.adx !== null && trend.dmi.adx >= t.adxTrendMin,
    );
    const stockPct = marketContext.relativeStrengthVsSPY?.periodPct;
    const spyPct = marketContext.relativeStrengthVsSPY?.benchmarkPeriodPct;
    check(
      bullish
        ? 'Stock period % > 0 while SPY period % < 0 (RS while SPY is down)'
        : 'Stock period % < 0 while SPY period % > 0 (RW while SPY is up)',
      stockPct !== null && stockPct !== undefined && spyPct !== null && spyPct !== undefined
        && (bullish ? stockPct > 0 && spyPct < 0 : stockPct < 0 && spyPct > 0),
    );
    // 2026-10-04 (degenerate-input hardening): null movingAverages fails closed, never throws.
    const ma = trend.movingAverages;
    const sma50 = ma !== null ? ma.sma50 : null;
    const sma200 = ma !== null ? ma.sma200 : null;
    check(
      bullish
        ? 'Bullish daily stack (price > SMA50 > SMA200)'
        : 'Bearish daily stack (price < SMA50 < SMA200)',
      sma50 !== null && sma200 !== null
        && (bullish
          ? currentPrice > sma50 && sma50 > sma200
          : currentPrice < sma50 && sma50 < sma200),
    );
    const emaFast = ma !== null ? ma.ema9 : null;
    const emaSlow = ma !== null ? ma.ema20 : null;
    check(
      bullish
        ? 'EMA9 > EMA20 (existing EMAs; Argus does not compute EMA8/EMA21)'
        : 'EMA9 < EMA20 (existing EMAs; Argus does not compute EMA8/EMA21)',
      emaFast !== null && emaSlow !== null && (bullish ? emaFast > emaSlow : emaFast < emaSlow),
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
      // Directional relative strength IS this setup - without the RS input there is nothing to rotate on.
      triggerMet: rsNum !== null && (bullish ? rsNum > 0 : rsNum < 0),
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
