/**
 * Shared fixture builder for strategy unit tests (not itself a *.test.ts file, so vitest never
 * collects it as a suite). Every `StrategyDefinition.evaluate` is a pure function of a
 * StrategyContext - this returns a fully-populated, deliberately NEUTRAL default context (no
 * strategy's conditions should pass against the untouched defaults), so each test only needs to
 * override the handful of fields relevant to the condition it's proving.
 */
import { StrategyContext } from './types';

export function baseFixture(): StrategyContext {
  return {
    symbol: 'TEST',
    currentPrice: 100,
    trend: {
      movingAverages: { sma20: 100, sma50: 100, sma100: 100, sma200: 100, ema9: 100, ema20: 100, ema50: 100, ema200: 100 },
      priceVsSMA20: { diff: 0, diffPct: 0, above: false },
      priceVsSMA50: { diff: 0, diffPct: 0, above: false },
      priceVsSMA200: { diff: 0, diffPct: 0, above: false },
      sma50SlopePct: 0,
      dmi: { plusDI: 20, minusDI: 20, adx: 10 },
      structure: { trend: 'SIDEWAYS', event: 'NONE', lastSwingHigh: null, lastSwingLow: null },
    },
    momentum: { rsi: 50, macd: { macd: 0, signal: 0, histogram: 0 }, stochasticRSI: 50, roc: 0, momentum: 0, williamsR: -50, cci: 0 },
    volatility: { atr: 1, atrPercent: 1, historicalVolatilityPct: 20, volatilityPercentile: 50, bollingerBandWidthPct: 5, keltner: { middle: 100, upper: 105, lower: 95 }, regime: 'STABLE' },
    volume: { volumeSMA20: 1_000_000, relativeVolume: 1, isSpike: false, volumeROC: 0, obv: 0, mfi: 50, vwap: { vwap: 100, distancePct: 0, slopePct: 0, event: 'NONE' }, cmf: 0, ad: 0 },
    priceAction: { gap: { type: null, sizePct: null }, consolidating: false, rangeRegime: 'STABLE', candlestick: null },
    supportResistance: {
      previousDay: null, dailyHighLow: null, weeklyHighLow: null, pivots: null, fibonacci: null, recentSwings: [],
      nearest: { nearestResistance: null, nearestSupport: null },
      openingRange: { available: false, reason: 'test fixture — no bars', data: null },
      priorChannel20: null,
    },
    regime: {
      regime: 'SIDEWAYS_RANGE', trendStrength: 10, volatility: 'NORMAL', marketStructure: 'CHOPPY', confidence: 0.3,
      features: {} as any, insufficientData: false,
    },
    marketContext: {
      spy: { symbol: 'SPY', regime: null, source: 'test' },
      qqq: { symbol: 'QQQ', regime: null, source: 'test' },
      iwm: { symbol: 'IWM', regime: null, source: 'test' },
      sector: { name: null, etf: null, trend: null },
      relativeStrengthVsSPY: null,
      relativeStrengthVsSector: null,
      breadth: { available: false, reason: 'test' },
    },
  };
}
