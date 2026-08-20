/**
 * Pure, deterministic technical-signal computation extracted from TechnicalAgent.ts's
 * checkStrategies() so it can be reused identically by both the live tick-driven agent and
 * Historical Evaluation (MODE B replay), with zero drift between the two. No side effects, no
 * EventBus, no live singletons - prices in, computed indicators + whichever signal(s) fired out.
 *
 * Extraction is behavior-preserving: TechnicalAgent.ts now calls this function instead of
 * duplicating the math, and emits the exact same events with the exact same values it always did
 * (see TechnicalAgent.checkStrategies-vs-technicalSignal.test.ts for the byte-identical
 * before/after regression proof).
 */
import { rsiEngine } from '../engines/RSIEngine';
import { macdEngine } from '../engines/MACDEngine';
import { quantThresholds } from '../config/quantThresholds';

export interface TechnicalIndicatorSnapshot {
  rsi: number;
  sma20: number;
  sma50: number;
  macd: number;
  macdSignal: number;
  bbUpper: number;
  bbLower: number;
}

export interface TechnicalFiredSignal {
  side: 'BUY' | 'SELL';
  confidence: number;
  reasoning: string;
}

export interface TechnicalSignalEvaluation {
  indicators: TechnicalIndicatorSnapshot;
  momentumBreakout: TechnicalFiredSignal | null;
  meanReversion: TechnicalFiredSignal | null;
  overbought: TechnicalFiredSignal | null;
}

export function calcSMA(prices: number[], period: number): number {
  if (prices.length < period) return prices[prices.length - 1];
  const slice = prices.slice(prices.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function calcBollingerBands(prices: number[], period: number = quantThresholds.bollingerPeriod): { upper: number; lower: number } {
  const sma = calcSMA(prices, period);
  const slice = prices.slice(prices.length - period);
  let sumSq = 0;
  for (const p of slice) sumSq += Math.pow(p - sma, 2);
  const stdDev = Math.sqrt(sumSq / period);
  return { upper: sma + stdDev * 2, lower: sma - stdDev * 2 };
}

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// Maps a 0-1 signal-strength score to a confidence in [0.55, 0.95] - a fired rule always has some
// baseline validity (it wouldn't have fired otherwise), and the strength score scales how far into
// "textbook" territory the actual indicator values are, rather than a fixed constant that doesn't
// distinguish a barely-triggered signal from an extreme one.
export function strengthToConfidence(strength01: number): number {
  return Number((0.55 + 0.40 * clamp01(strength01)).toFixed(3));
}

/**
 * Evaluates all three of TechnicalAgent's real strategies against one price series. All three are
 * checked (matching live TechnicalAgent.checkStrategies, which does not short-circuit), though in
 * practice at most one can ever fire because the RSI ranges (50-70 / <30 / >75) are mutually
 * exclusive by construction.
 */
export function evaluateTechnicalSignals(prices: number[]): TechnicalSignalEvaluation {
  const currentPrice = prices[prices.length - 1];
  const sma20 = calcSMA(prices, quantThresholds.bollingerPeriod);
  const sma50 = calcSMA(prices, 50);
  const rsi = rsiEngine.calculate(prices);
  const macd = macdEngine.calculate(prices);
  const bb = calcBollingerBands(prices, 20);
  const indicators: TechnicalIndicatorSnapshot = {
    rsi, sma20, sma50, macd: macd.macd, macdSignal: macd.signal, bbUpper: bb.upper, bbLower: bb.lower,
  };

  let momentumBreakout: TechnicalFiredSignal | null = null;
  if (currentPrice > sma20 && sma20 > sma50 && rsi > 50 && rsi < 70 && macd.macd > macd.signal) {
    const rsiStrength = clamp01((rsi - 50) / 20);
    const macdStrength = clamp01((macd.macd - macd.signal) / (currentPrice * 0.005));
    const trendStrength = clamp01((sma20 - sma50) / (currentPrice * 0.02));
    momentumBreakout = {
      side: 'BUY',
      confidence: strengthToConfidence((rsiStrength + macdStrength + trendStrength) / 3),
      reasoning: `Strong upward trend detected. MACD bullish crossover. RSI at ${rsi.toFixed(2)}.`,
    };
  }

  let meanReversion: TechnicalFiredSignal | null = null;
  if (rsi < 30 && currentPrice < bb.lower) {
    const rsiStrength = clamp01((30 - rsi) / 30);
    const bandWidth = bb.upper - bb.lower;
    const bbStrength = bandWidth > 0 ? clamp01((bb.lower - currentPrice) / bandWidth) : 0;
    meanReversion = {
      side: 'BUY',
      confidence: strengthToConfidence((rsiStrength + bbStrength) / 2),
      reasoning: `Oversold condition. Price breached lower Bollinger Band with RSI at ${rsi.toFixed(2)}.`,
    };
  }

  let overbought: TechnicalFiredSignal | null = null;
  if (rsi > 75 && currentPrice > bb.upper) {
    const rsiStrength = clamp01((rsi - 75) / 25);
    const bandWidth = bb.upper - bb.lower;
    const bbStrength = bandWidth > 0 ? clamp01((currentPrice - bb.upper) / bandWidth) : 0;
    overbought = {
      side: 'SELL',
      confidence: strengthToConfidence((rsiStrength + bbStrength) / 2),
      reasoning: `Overbought condition. Price exceeded upper Bollinger Band. RSI at ${rsi.toFixed(2)}.`,
    };
  }

  return { indicators, momentumBreakout, meanReversion, overbought };
}
