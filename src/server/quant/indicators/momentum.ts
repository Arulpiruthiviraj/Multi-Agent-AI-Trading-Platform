/**
 * ==========================================================
 * Module: indicators/momentum
 *
 * Purpose:
 * Momentum-family features not already present: Stochastic RSI, ROC, Momentum, Williams %R, CCI.
 *
 * RSI and MACD are explicitly NOT reimplemented here - `computeMomentumFeatures` imports and
 * calls the existing `rsiEngine`/`macdEngine` singletons (src/server/engines/{RSIEngine,
 * MACDEngine}.ts) exactly as TechnicalAgent.ts and BacktestEngine.ts already do, so this file
 * adds a second opinion alongside the existing indicators, never a competing implementation.
 * ==========================================================
 */
import { rsiEngine } from '../../engines/RSIEngine';
import { macdEngine } from '../../engines/MACDEngine';
import { Bar } from '../../engines/backtest/HistoricalDataGateway';

/** Rate of Change (%) over `period` bars. Null if there isn't enough history or the anchor price
 *  is 0 (an undefined percentage, not a fabricated one). */
export function calculateROC(closes: number[], period: number = 12): number | null {
  if (closes.length < period + 1) return null;
  const anchor = closes[closes.length - 1 - period];
  if (anchor === 0) return null;
  return ((closes[closes.length - 1] - anchor) / anchor) * 100;
}

/** Absolute Momentum (current close minus the close `period` bars ago) - deliberately not a
 *  percentage (that's ROC above); this is the raw price-difference convention. */
export function calculateMomentum(closes: number[], period: number = 10): number | null {
  if (closes.length < period + 1) return null;
  return closes[closes.length - 1] - closes[closes.length - 1 - period];
}

/** Williams %R, -100 to 0. Null if the period's high/low range is exactly flat (undefined, not a
 *  fabricated midpoint). */
export function calculateWilliamsR(highs: number[], lows: number[], closes: number[], period: number = 14): number | null {
  if (closes.length < period) return null;
  const highestHigh = Math.max(...highs.slice(-period));
  const lowestLow = Math.min(...lows.slice(-period));
  if (highestHigh === lowestLow) return null;
  return ((highestHigh - closes[closes.length - 1]) / (highestHigh - lowestLow)) * -100;
}

/** Commodity Channel Index over `period` bars using the standard typical-price + mean-absolute-
 *  deviation formula. Null if mean deviation is exactly 0 (flat typical price - undefined, not a
 *  fabricated 0). */
export function calculateCCI(highs: number[], lows: number[], closes: number[], period: number = 20): number | null {
  if (closes.length < period) return null;
  const typicalPrices: number[] = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    typicalPrices.push((highs[i] + lows[i] + closes[i]) / 3);
  }
  const smaTP = typicalPrices.reduce((a, b) => a + b, 0) / period;
  const meanDeviation = typicalPrices.reduce((a, b) => a + Math.abs(b - smaTP), 0) / period;
  if (meanDeviation === 0) return null;
  const currentTP = typicalPrices[typicalPrices.length - 1];
  return (currentTP - smaTP) / (0.015 * meanDeviation);
}

/** Stochastic RSI: RSI's own value normalized against its rolling range over `stochPeriod` bars
 *  of RSI history (0-100, distinct from Stochastic %K applied to price). Requires computing a
 *  real trailing RSI *series*, not just RSIEngine's single latest value - built here by sliding
 *  RSIEngine.calculate() over successive windows (cheap: O(rsiPeriod) per call, stochPeriod calls). */
export function calculateStochasticRSI(closes: number[], rsiPeriod: number = 14, stochPeriod: number = 14): number | null {
  const minRequired = rsiPeriod + stochPeriod;
  if (closes.length < minRequired) return null;

  const rsiSeries: number[] = [];
  for (let end = closes.length - stochPeriod + 1; end <= closes.length; end++) {
    rsiSeries.push(rsiEngine.calculate(closes.slice(0, end)));
  }

  const highestRSI = Math.max(...rsiSeries);
  const lowestRSI = Math.min(...rsiSeries);
  if (highestRSI === lowestRSI) return null;
  const currentRSI = rsiSeries[rsiSeries.length - 1];
  return ((currentRSI - lowestRSI) / (highestRSI - lowestRSI)) * 100;
}

export interface MomentumFeatures {
  rsi: number;                 // existing RSIEngine, untouched
  macd: { macd: number; signal: number; histogram: number }; // existing MACDEngine, untouched
  stochasticRSI: number | null;
  roc: number | null;
  momentum: number | null;
  williamsR: number | null;
  cci: number | null;
}

export function computeMomentumFeatures(bars: Bar[]): MomentumFeatures {
  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);

  return {
    rsi: rsiEngine.calculate(closes),
    macd: macdEngine.calculate(closes),
    stochasticRSI: calculateStochasticRSI(closes),
    roc: calculateROC(closes),
    momentum: calculateMomentum(closes),
    williamsR: calculateWilliamsR(highs, lows, closes),
    cci: calculateCCI(highs, lows, closes),
  };
}
