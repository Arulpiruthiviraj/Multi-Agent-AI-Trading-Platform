/**
 * Point-in-time technical assessment for historical evaluation.
 * Reuses production indicator engines — no EventBus, no live agent loop.
 */
import type { ResearchBar } from '../research/ohlcvTypes';
import { rsiEngine } from '../engines/RSIEngine';
import { macdEngine } from '../engines/MACDEngine';
import { quantThresholds } from '../config/quantThresholds';

export interface ReplayTechnicalSnapshot {
  status: 'PARTIAL';
  reason: string;
  currentPrice: number;
  rsi: number;
  sma20: number;
  sma50: number;
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  bbUpper: number;
  bbLower: number;
  bbMiddle: number;
  side: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  engines: string[];
}

function calcSMA(prices: number[], period: number): number {
  if (prices.length < period) return prices[prices.length - 1] ?? 0;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcBollingerBands(prices: number[], period: number = quantThresholds.bollingerPeriod) {
  const sma = calcSMA(prices, period);
  const slice = prices.slice(-period);
  let sumSq = 0;
  for (const p of slice) sumSq += Math.pow(p - sma, 2);
  const stdDev = Math.sqrt(sumSq / period);
  return { upper: sma + stdDev * 2, lower: sma - stdDev * 2, middle: sma };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function strengthToConfidence(strength01: number): number {
  return Number((0.55 + 0.40 * clamp01(strength01)).toFixed(3));
}

/**
 * Evaluate technical signals on point-in-time closes (bars already filtered to timestamp < T).
 * Mirrors TechnicalAgent.ts rule structure without live dependencies.
 */
export function evaluateReplayTechnical(visible: ResearchBar[]): ReplayTechnicalSnapshot | null {
  if (visible.length < quantThresholds.technicalHistoryBars) return null;
  const prices = visible.map((b) => b.close);
  const currentPrice = prices[prices.length - 1];
  const sma20 = calcSMA(prices, quantThresholds.bollingerPeriod);
  const sma50 = calcSMA(prices, 50);
  const rsi = rsiEngine.calculate(prices);
  const macd = macdEngine.calculate(prices);
  const bb = calcBollingerBands(prices, quantThresholds.bollingerPeriod);

  let side: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  let confidence = 0;

  if (currentPrice > sma20 && sma20 > sma50 && rsi > 50 && rsi < 70 && macd.macd > macd.signal) {
    const rsiStrength = clamp01((rsi - 50) / 20);
    const macdStrength = clamp01((macd.macd - macd.signal) / (currentPrice * 0.005));
    const trendStrength = clamp01((sma20 - sma50) / (currentPrice * 0.02));
    side = 'BUY';
    confidence = strengthToConfidence((rsiStrength + macdStrength + trendStrength) / 3);
  } else if (rsi < 30 && currentPrice < bb.lower) {
    side = 'BUY';
    confidence = strengthToConfidence(clamp01((30 - rsi) / 30));
  } else if (rsi > 70 && currentPrice > bb.upper) {
    side = 'SELL';
    confidence = strengthToConfidence(clamp01((rsi - 70) / 30));
  }

  return {
    status: 'PARTIAL',
    reason: 'RSI/MACD/SMA/Bollinger on PIT bars via production engines; not full live tick-driven TechnicalAgent loop or EventBus',
    currentPrice,
    rsi,
    sma20,
    sma50,
    macd: macd.macd,
    macdSignal: macd.signal,
    macdHistogram: macd.histogram,
    bbUpper: bb.upper,
    bbLower: bb.lower,
    bbMiddle: bb.middle,
    side,
    confidence,
    engines: ['RSIEngine', 'MACDEngine', 'SMA', 'BollingerBands'],
  };
}
