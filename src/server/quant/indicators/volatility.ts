/**
 * ==========================================================
 * Module: indicators/volatility
 *
 * Purpose:
 * Volatility-family features: ATR% (wraps the existing TechnicalIndicators.calculateATR - not
 * reimplemented), historical/realized volatility, volatility percentile (via statistics.ts's real
 * percentileRank, never fabricated), Bollinger Band width (wraps the existing
 * calculateBollingerBands), Keltner Channels (new), and expansion/contraction classification.
 * ==========================================================
 */
import { TechnicalIndicators } from '../../engines/TechnicalIndicators';
import { Bar } from '../../engines/backtest/HistoricalDataGateway';
import { rollingVolatility, percentileRank } from '../statistics';

/** ATR expressed as a % of current price - the size-independent form most comparisons actually
 *  want (a $2 ATR means something different on a $10 stock vs. a $500 stock). */
export function atrPercent(highs: number[], lows: number[], closes: number[], period: number = 14): number | null {
  const currentPrice = closes[closes.length - 1];
  if (!currentPrice) return null;
  const atr = TechnicalIndicators.calculateATR(highs, lows, closes, period);
  if (atr === 0) return null;
  return (atr / currentPrice) * 100;
}

/** Annualized realized volatility (stddev of daily returns over `period` bars, scaled by
 *  sqrt(periodsPerYear)). `periodsPerYear` defaults to 252 (daily bars) - pass a different value
 *  for intraday timeframes; this function does not assume a bar's timeframe for you. */
export function historicalVolatility(closes: number[], period: number = 20, periodsPerYear: number = 252): number | null {
  const vol = rollingVolatility(closes, period);
  if (vol === null) return null;
  return vol * Math.sqrt(periodsPerYear) * 100; // as a %
}

/** Where today's ATR% ranks (0-100) against its own trailing `lookback`-bar history - "is
 *  volatility currently high or low relative to its own recent normal," not an absolute
 *  threshold. Null (not fabricated) if there isn't enough history to build a real distribution. */
export function volatilityPercentile(bars: Bar[], lookback: number = 100, atrPeriod: number = 14): number | null {
  if (bars.length < lookback + atrPeriod) return null;
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const closes = bars.map(b => b.close);

  const history: number[] = [];
  const start = bars.length - lookback;
  for (let i = start; i < bars.length; i++) {
    const pct = atrPercent(highs.slice(0, i + 1), lows.slice(0, i + 1), closes.slice(0, i + 1), atrPeriod);
    if (pct !== null) history.push(pct);
  }
  if (history.length === 0) return null;
  const current = history[history.length - 1];
  return percentileRank(history.slice(0, -1), current);
}

/** Bollinger Band width as a % of the middle band - a real, size-independent measure of how wide
 *  the bands currently are (a classic "squeeze" precursor when it contracts). Wraps the existing
 *  calculateBollingerBands rather than recomputing SMA/stddev a second way. */
export function bollingerBandWidth(prices: number[], period: number = 20, stdDev: number = 2): number | null {
  if (prices.length < period) return null;
  const bb = TechnicalIndicators.calculateBollingerBands(prices, period, stdDev);
  if (bb.middle === 0) return null;
  return ((bb.upper - bb.lower) / bb.middle) * 100;
}

export interface KeltnerChannels {
  middle: number;
  upper: number;
  lower: number;
}

/** Real Keltner Channels: EMA(emaPeriod) middle line, ATR(atrPeriod)*multiplier bands - genuinely
 *  new to this codebase (no prior implementation found anywhere). */
export function keltnerChannels(highs: number[], lows: number[], closes: number[], emaPeriod: number = 20, atrPeriod: number = 10, multiplier: number = 2): KeltnerChannels | null {
  if (closes.length < Math.max(emaPeriod, atrPeriod + 1)) return null;
  const middle = TechnicalIndicators.calculateEMA(closes, emaPeriod);
  const atr = TechnicalIndicators.calculateATR(highs, lows, closes, atrPeriod);
  return { middle, upper: middle + multiplier * atr, lower: middle - multiplier * atr };
}

export type VolatilityRegime = 'EXPANDING' | 'CONTRACTING' | 'STABLE';

/** Compares the most recent ATR% reading against the average ATR% of the preceding `lookback`
 *  bars - real relative comparison, not an arbitrary absolute cutoff. &gt;15% above/below the
 *  recent average is EXPANDING/CONTRACTING; otherwise STABLE. */
export function classifyVolatilityRegime(bars: Bar[], lookback: number = 20, atrPeriod: number = 14): VolatilityRegime | null {
  if (bars.length < lookback + atrPeriod + 1) return null;
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const closes = bars.map(b => b.close);

  const readings: number[] = [];
  for (let i = bars.length - lookback; i <= bars.length; i++) {
    const pct = atrPercent(highs.slice(0, i), lows.slice(0, i), closes.slice(0, i), atrPeriod);
    if (pct !== null) readings.push(pct);
  }
  if (readings.length < 2) return null;

  const current = readings[readings.length - 1];
  const priorAvg = readings.slice(0, -1).reduce((a, b) => a + b, 0) / (readings.length - 1);
  if (priorAvg === 0) return 'STABLE';
  const changePct = ((current - priorAvg) / priorAvg) * 100;
  if (changePct > 15) return 'EXPANDING';
  if (changePct < -15) return 'CONTRACTING';
  return 'STABLE';
}

export interface VolatilityFeatures {
  atr: number;
  atrPercent: number | null;
  historicalVolatilityPct: number | null;
  volatilityPercentile: number | null;
  bollingerBandWidthPct: number | null;
  keltner: KeltnerChannels | null;
  regime: VolatilityRegime | null;
}

export function computeVolatilityFeatures(bars: Bar[]): VolatilityFeatures {
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const closes = bars.map(b => b.close);

  return {
    atr: TechnicalIndicators.calculateATR(highs, lows, closes, 14),
    atrPercent: atrPercent(highs, lows, closes),
    historicalVolatilityPct: historicalVolatility(closes),
    volatilityPercentile: volatilityPercentile(bars),
    bollingerBandWidthPct: bollingerBandWidth(closes),
    keltner: keltnerChannels(highs, lows, closes),
    regime: classifyVolatilityRegime(bars),
  };
}
