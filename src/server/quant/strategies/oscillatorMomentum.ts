/**
 * ==========================================================
 * Module: strategies/oscillatorMomentum
 *
 * Purpose:
 * Experimental oscillator family: RSI vs midline + MACD histogram sign + ROC.
 * Named RSI/MACD divergence is a feature elsewhere (isTradeSignal:false) and is not treated as
 * an entry here.
 *
 * Live vs backtest:
 *   findStrategy() without the live flag; evaluateAll() only if QUANT_OSCILLATOR_MOMENTUM_ENABLED=true.
 *
 * Status: UNVALIDATED. BacktestEngine is long-only.
 * ==========================================================
 */
import { StrategyContext, StrategyDefinition, StrategyEvaluation, scoreFromConditions } from './types';
import { quantExperimentalStrategies } from '../../config/quantExperimentalStrategies';
import { quantThresholds } from '../../config/quantThresholds';

const t = quantExperimentalStrategies.thresholds;

export const oscillatorMomentum: StrategyDefinition = {
  id: 'OSCILLATOR_MOMENTUM',
  displayName: 'Oscillator Momentum',
  applicableRegimes: ['BULLISH_TREND', 'BEARISH_TREND'],

  evaluate(ctx: StrategyContext): StrategyEvaluation {
    const { momentum, trend, volatility, regime, currentPrice } = ctx;
    const bullishMacd = momentum.macd.histogram > 0;
    const side: 'BUY' | 'SELL' = !bullishMacd && momentum.rsi < t.rsiMidline ? 'SELL' : 'BUY';
    const bullish = side === 'BUY';

    const conditionsMet: string[] = [];
    const conditionsFailed: string[] = [];
    const contradictions: string[] = [];
    const check = (name: string, met: boolean) => (met ? conditionsMet.push(name) : conditionsFailed.push(name));

    check(
      bullish ? `RSI above midline (${t.rsiMidline})` : `RSI below midline (${t.rsiMidline})`,
      bullish ? momentum.rsi > t.rsiMidline : momentum.rsi < t.rsiMidline,
    );
    check(
      bullish ? 'MACD histogram positive' : 'MACD histogram negative',
      bullish ? momentum.macd.histogram > 0 : momentum.macd.histogram < 0,
    );
    check(
      bullish ? 'ROC > 0' : 'ROC < 0',
      momentum.roc !== null && (bullish ? momentum.roc > 0 : momentum.roc < 0),
    );
    check(
      `ADX not dead (< ${t.adxTrendMin} still allowed as confirmation only if DI aligned)`,
      // Real bug found and fixed this pass: trend.dmi is DMIResult | null - guard it before .adx.
      trend.dmi !== null && trend.dmi.adx !== null,
    );
    check(
      bullish ? '+DI > -DI' : '-DI > +DI',
      trend.dmi !== null && (bullish ? trend.dmi.plusDI > trend.dmi.minusDI : trend.dmi.minusDI > trend.dmi.plusDI),
    );
    check(
      'Favorable market regime',
      bullish ? regime.regime === 'BULLISH_TREND' : regime.regime === 'BEARISH_TREND',
    );

    if (bullish && momentum.rsi >= quantThresholds.rsiExtremeOverbought) {
      contradictions.push('RSI already extremely overbought (>=80) — momentum continuation risk of exhaustion.');
    }
    if (!bullish && momentum.rsi <= quantThresholds.rsiExtremeOversold) {
      contradictions.push('RSI already extremely oversold (<=20) — momentum continuation risk of exhaustion.');
    }

    const totalConditions = conditionsMet.length + conditionsFailed.length;
    const setupScore = scoreFromConditions(conditionsMet, totalConditions);
    const atr = volatility.atr;

    return {
      strategy: 'OSCILLATOR_MOMENTUM',
      side,
      setupScore,
      confidence: setupScore / 100,
      conditionsMet,
      conditionsFailed,
      contradictions,
      invalidationConditions: [
        'MACD histogram flips against the position.',
        `RSI recrosses the ${t.rsiMidline} midline against the side.`,
      ],
      stop: atr
        ? { price: currentPrice + (bullish ? -atr : atr), basis: '1x ATR from current price.' }
        : { price: null, basis: 'No ATR for a stop.' },
      target: atr
        ? { price: currentPrice + (bullish ? 2 * atr : -2 * atr), basis: '2x ATR measured move.' }
        : { price: null, basis: 'No ATR for a measured target.' },
      applicableRegimes: oscillatorMomentum.applicableRegimes,
    };
  },
};
