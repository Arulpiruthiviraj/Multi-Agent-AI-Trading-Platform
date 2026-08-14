/**
 * ==========================================================
 * Module: indicators/trend
 *
 * Purpose:
 * Trend-family features: SMA/EMA sets, moving-average slope, price-vs-MA, a real Wilder-smoothed
 * ADX/DMI (see note below), swing-point HH/HL/LH/LL detection, and Break of Structure / Change of
 * Character classification.
 *
 * Reuses TechnicalIndicators.calculateSMA/calculateEMA (src/server/engines/TechnicalIndicators.ts)
 * rather than reimplementing them - this file only adds what doesn't already exist.
 *
 * ADX note: TechnicalIndicators.calculateADX already exists but returns raw DX (a single Wilder-
 * smoothing pass on +DM/-DM, no second smoothing pass on DX itself - confirmed by reading its
 * source). That function and its one real caller (AdvancedQuantEngines, telemetry-only) are left
 * completely untouched per this initiative's "never silently change existing behavior" rule.
 * `calculateDMI` below is a separate, new, properly double-smoothed ADX/DMI implementation.
 * ==========================================================
 */
import { TechnicalIndicators } from '../../engines/TechnicalIndicators';
import { Bar } from '../../engines/backtest/HistoricalDataGateway';

export interface MovingAverageSet {
  sma20: number | null;
  sma50: number | null;
  sma100: number | null;
  sma200: number | null;
  ema9: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
}

/** Null (not 0, not the existing functions' "last price" fallback) when there isn't enough real
 *  history for a given period - a caller asking for SMA200 on 40 bars should see "not computable"
 *  rather than a value quietly computed over fewer bars than requested. */
export function movingAverageSet(closes: number[]): MovingAverageSet {
  const sma = (p: number) => (closes.length >= p ? TechnicalIndicators.calculateSMA(closes, p) : null);
  const ema = (p: number) => (closes.length >= p ? TechnicalIndicators.calculateEMA(closes, p) : null);
  return {
    sma20: sma(20), sma50: sma(50), sma100: sma(100), sma200: sma(200),
    ema9: ema(9), ema20: ema(20), ema50: ema(50), ema200: ema(200),
  };
}

/** % change of a moving average's own value over `lookbackBars`, e.g. slope of SMA50 over the
 *  last 10 bars - a real measure of whether the MA itself is rising/falling, not just where price
 *  sits relative to it. Null if there isn't enough history for two real MA readings. */
export function maSlopePct(closes: number[], period: number, lookbackBars: number, kind: 'sma' | 'ema' = 'sma'): number | null {
  if (closes.length < period + lookbackBars) return null;
  const calc = kind === 'sma' ? TechnicalIndicators.calculateSMA : TechnicalIndicators.calculateEMA;
  const now = calc(closes, period);
  const then = calc(closes.slice(0, closes.length - lookbackBars), period);
  if (then === 0) return null;
  return ((now - then) / then) * 100;
}

export interface PriceVsMA {
  diff: number;
  diffPct: number;
  above: boolean;
}

export function priceVsMA(currentPrice: number, maValue: number | null): PriceVsMA | null {
  if (maValue === null || maValue === 0) return null;
  const diff = currentPrice - maValue;
  return { diff, diffPct: (diff / maValue) * 100, above: diff > 0 };
}

export interface DMIResult {
  plusDI: number;
  minusDI: number;
  adx: number; // Wilder-smoothed ADX (DX itself smoothed over `period`), distinct from the
               // existing calculateADX's single-pass DX
}

/** Real, properly double-smoothed Wilder ADX/DMI. Distinct new function - see module header. */
export function calculateDMI(highs: number[], lows: number[], closes: number[], period: number = 14): DMIResult | null {
  if (closes.length < period * 2 + 1) return null;

  const plusDM: number[] = [], minusDM: number[] = [], trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    trs.push(Math.max(hl, hc, lc));
  }

  const wilderSmooth = (series: number[]): number[] => {
    const out: number[] = [series.slice(0, period).reduce((a, b) => a + b, 0)];
    for (let i = period; i < series.length; i++) {
      out.push(out[out.length - 1] - out[out.length - 1] / period + series[i]);
    }
    return out;
  };

  const smoothTR = wilderSmooth(trs);
  const smoothPlusDM = wilderSmooth(plusDM);
  const smoothMinusDM = wilderSmooth(minusDM);

  const dxSeries: number[] = [];
  for (let i = 0; i < smoothTR.length; i++) {
    if (smoothTR[i] === 0) { dxSeries.push(0); continue; }
    const plusDI = 100 * (smoothPlusDM[i] / smoothTR[i]);
    const minusDI = 100 * (smoothMinusDM[i] / smoothTR[i]);
    const sum = plusDI + minusDI;
    dxSeries.push(sum === 0 ? 0 : (Math.abs(plusDI - minusDI) / sum) * 100);
  }
  if (dxSeries.length < period) return null;

  // Second Wilder-smoothing pass, over DX itself, is what makes this "ADX" rather than "DX".
  let adx = dxSeries.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxSeries.length; i++) {
    adx = ((adx * (period - 1)) + dxSeries[i]) / period;
  }

  const lastTR = smoothTR[smoothTR.length - 1];
  const plusDI = lastTR === 0 ? 0 : 100 * (smoothPlusDM[smoothPlusDM.length - 1] / lastTR);
  const minusDI = lastTR === 0 ? 0 : 100 * (smoothMinusDM[smoothMinusDM.length - 1] / lastTR);

  return { plusDI, minusDI, adx };
}

export type SwingPointKind = 'HH' | 'HL' | 'LH' | 'LL';

export interface SwingPoint {
  index: number;
  timestamp: number;
  price: number;
  type: 'high' | 'low';
  kind: SwingPointKind | null; // null until a prior same-type swing exists to compare against
}

/** Real fractal swing-point detection: bar i is a swing high if its high exceeds every bar's high
 *  within `lookback` bars on both sides (swing low is the mirror on lows). Each detected swing is
 *  then classified HH/LH (highs) or HL/LL (lows) relative to the immediately preceding swing of
 *  the same type - the standard price-action definition. */
export function detectSwingPoints(bars: Bar[], lookback: number = 2): SwingPoint[] {
  const points: SwingPoint[] = [];
  let lastHigh: number | null = null;
  let lastLow: number | null = null;

  for (let i = lookback; i < bars.length - lookback; i++) {
    const windowHighs = bars.slice(i - lookback, i + lookback + 1).map(b => b.high);
    const windowLows = bars.slice(i - lookback, i + lookback + 1).map(b => b.low);

    if (bars[i].high === Math.max(...windowHighs) && windowHighs.filter(h => h === bars[i].high).length === 1) {
      const kind: SwingPointKind | null = lastHigh === null ? null : (bars[i].high > lastHigh ? 'HH' : 'LH');
      points.push({ index: i, timestamp: bars[i].timestamp, price: bars[i].high, type: 'high', kind });
      lastHigh = bars[i].high;
    } else if (bars[i].low === Math.min(...windowLows) && windowLows.filter(l => l === bars[i].low).length === 1) {
      const kind: SwingPointKind | null = lastLow === null ? null : (bars[i].low > lastLow ? 'HL' : 'LL');
      points.push({ index: i, timestamp: bars[i].timestamp, price: bars[i].low, type: 'low', kind });
      lastLow = bars[i].low;
    }
  }
  return points;
}

export type MarketStructureEvent = 'BOS_BULLISH' | 'BOS_BEARISH' | 'CHOCH_BULLISH' | 'CHOCH_BEARISH' | 'NONE';

export interface MarketStructureResult {
  trend: 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS';
  event: MarketStructureEvent;
  lastSwingHigh: number | null;
  lastSwingLow: number | null;
}

/**
 * Deterministic Break-of-Structure / Change-of-Character classification, defined precisely (one
 * of several conventions used in retail price-action trading - documented here so it's reviewable
 * rather than an opaque black box):
 *   - Trend is UPTREND if the last two same-type swings are both HH and HL (higher highs AND
 *     higher lows), DOWNTREND if both LH and LL, else SIDEWAYS.
 *   - BOS = the latest close breaks past the last swing point IN THE DIRECTION of the established
 *     trend (continuation - e.g. an uptrend's close pushing above its last swing high).
 *   - CHoCH = the latest close breaks past a swing point AGAINST the established trend (the first
 *     sign of a potential reversal - e.g. an uptrend's close dropping below its last swing low).
 */
export function detectMarketStructure(bars: Bar[], lookback: number = 2): MarketStructureResult {
  const swings = detectSwingPoints(bars, lookback);
  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');
  const lastHigh = highs.length ? highs[highs.length - 1] : null;
  const lastLow = lows.length ? lows[lows.length - 1] : null;

  const recentHighKinds = highs.slice(-2).map(s => s.kind);
  const recentLowKinds = lows.slice(-2).map(s => s.kind);
  const isUp = recentHighKinds.every(k => k === 'HH') && recentLowKinds.every(k => k === 'HL') && recentHighKinds.length > 0 && recentLowKinds.length > 0;
  const isDown = recentHighKinds.every(k => k === 'LH') && recentLowKinds.every(k => k === 'LL') && recentHighKinds.length > 0 && recentLowKinds.length > 0;
  const trend: MarketStructureResult['trend'] = isUp ? 'UPTREND' : isDown ? 'DOWNTREND' : 'SIDEWAYS';

  const lastClose = bars.length ? bars[bars.length - 1].close : null;
  let event: MarketStructureEvent = 'NONE';
  if (lastClose !== null) {
    if (trend === 'UPTREND') {
      if (lastHigh && lastClose > lastHigh.price) event = 'BOS_BULLISH';
      else if (lastLow && lastClose < lastLow.price) event = 'CHOCH_BEARISH';
    } else if (trend === 'DOWNTREND') {
      if (lastLow && lastClose < lastLow.price) event = 'BOS_BEARISH';
      else if (lastHigh && lastClose > lastHigh.price) event = 'CHOCH_BULLISH';
    }
  }

  return { trend, event, lastSwingHigh: lastHigh?.price ?? null, lastSwingLow: lastLow?.price ?? null };
}

export interface TrendFeatures {
  movingAverages: MovingAverageSet;
  priceVsSMA20: PriceVsMA | null;
  priceVsSMA50: PriceVsMA | null;
  priceVsSMA200: PriceVsMA | null;
  sma50SlopePct: number | null; // over the trailing 10 bars
  dmi: DMIResult | null;
  structure: MarketStructureResult;
}

/** Single entry point most callers (RegimeEngine, StrategyEngine, QuantSignalAgent) should use -
 *  assembles every trend feature above from one real bar array. */
export function computeTrendFeatures(bars: Bar[]): TrendFeatures {
  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const currentPrice = closes[closes.length - 1] ?? 0;
  const mas = movingAverageSet(closes);

  return {
    movingAverages: mas,
    priceVsSMA20: priceVsMA(currentPrice, mas.sma20),
    priceVsSMA50: priceVsMA(currentPrice, mas.sma50),
    priceVsSMA200: priceVsMA(currentPrice, mas.sma200),
    sma50SlopePct: maSlopePct(closes, 50, 10, 'sma'),
    dmi: calculateDMI(highs, lows, closes),
    structure: detectMarketStructure(bars),
  };
}
