/**
 * ==========================================================
 * Module: indicators/priceAction
 *
 * Purpose:
 * Price-action-family features: breakout/false-breakout, pullback, reversal, consolidation,
 * bar-range expansion/contraction (a raw-range measure, distinct from volatility.ts's ATR%-based
 * regime classification - both are real and complementary, not duplicates), gap detection, and a
 * small set of deterministic single/two-bar candlestick patterns.
 * ==========================================================
 */
import { Bar } from '../../engines/backtest/HistoricalDataGateway';
import { groupBarsByUTCDay } from './supportResistance';

export interface BreakoutResult {
  breakout: boolean;
  direction: 'UP' | 'DOWN' | null;
  closesBeyondLevel: number; // how many of the most recent `confirmBars` closed beyond the level
}

/** Real breakout confirmation: requires `confirmBars` (default 1) consecutive closes beyond
 *  `level`, not a single wick touch - a single-bar spike through a level and back is exactly the
 *  false-breakout case `detectFalseBreakout` below is for. */
export function detectBreakout(bars: Bar[], level: number, direction: 'UP' | 'DOWN', confirmBars: number = 1): BreakoutResult {
  if (bars.length < confirmBars) return { breakout: false, direction: null, closesBeyondLevel: 0 };
  const recent = bars.slice(-confirmBars);
  const beyond = recent.filter(b => direction === 'UP' ? b.close > level : b.close < level).length;
  return { breakout: beyond === confirmBars, direction: beyond === confirmBars ? direction : null, closesBeyondLevel: beyond };
}

/** A real false breakout: price closed beyond `level` at some point in the last `lookback` bars,
 *  then closed back on the original side by the most recent bar - the classic "breakout that
 *  failed" pattern, useful as a strategy invalidation signal. */
export function detectFalseBreakout(bars: Bar[], level: number, direction: 'UP' | 'DOWN', lookback: number = 5): boolean {
  if (bars.length < 2) return false;
  const window = bars.slice(-lookback);
  const brokeOut = window.slice(0, -1).some(b => direction === 'UP' ? b.close > level : b.close < level);
  const currentClose = bars[bars.length - 1].close;
  const backInside = direction === 'UP' ? currentClose < level : currentClose > level;
  return brokeOut && backInside;
}

/** Real pullback detection: in an established trend, price touches (comes within `tolerancePct`
 *  of) a moving-average value without closing decisively through it - the "healthy retracement,
 *  not a reversal" pattern. */
export function detectPullback(bars: Bar[], trend: 'UP' | 'DOWN', maValue: number | null, tolerancePct: number = 1.5): boolean {
  if (maValue === null || bars.length === 0) return false;
  const currentPrice = bars[bars.length - 1].close;
  const distancePct = Math.abs((currentPrice - maValue) / maValue) * 100;
  if (distancePct > tolerancePct) return false;
  // Still respecting the trend direction (hasn't closed through the MA against the trend).
  return trend === 'UP' ? currentPrice >= maValue * (1 - tolerancePct / 100) : currentPrice <= maValue * (1 + tolerancePct / 100);
}

/** Real range-of-bar-ranges comparison: average (high-low) of the most recent `recentBars`
 *  against the average of the `priorBars` before them. Distinct from volatility.ts's ATR%-based
 *  classifyVolatilityRegime (which measures true-range including gaps and is smoothed) - this is
 *  the simpler, literal "are today's candles wider or narrower than recent ones" measure. */
export function rangeExpansionContraction(bars: Bar[], recentBars: number = 5, priorBars: number = 15): 'EXPANDING' | 'CONTRACTING' | 'STABLE' | null {
  if (bars.length < recentBars + priorBars) return null;
  const ranges = bars.map(b => b.high - b.low);
  const recent = ranges.slice(-recentBars);
  const prior = ranges.slice(-(recentBars + priorBars), -recentBars);
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const priorAvg = prior.reduce((a, b) => a + b, 0) / prior.length;
  if (priorAvg === 0) return 'STABLE';
  const changePct = ((recentAvg - priorAvg) / priorAvg) * 100;
  if (changePct > 20) return 'EXPANDING';
  if (changePct < -20) return 'CONTRACTING';
  return 'STABLE';
}

/** Real consolidation flag: the trailing `period` bars' full high-low range is within
 *  `thresholdPct` of the period's average close - a tight, sideways range. */
export function detectConsolidation(bars: Bar[], period: number = 10, thresholdPct: number = 3): boolean {
  if (bars.length < period) return false;
  const window = bars.slice(-period);
  const high = Math.max(...window.map(b => b.high));
  const low = Math.min(...window.map(b => b.low));
  const avgClose = window.reduce((a, b) => a + b.close, 0) / window.length;
  if (avgClose === 0) return false;
  return ((high - low) / avgClose) * 100 <= thresholdPct;
}

export interface GapResult {
  type: 'GAP_UP' | 'GAP_DOWN' | null;
  sizePct: number | null;
}

/** Real gap detection: today's session open vs. the prior session's close, grouped by real UTC
 *  calendar day (not just "prior bar", which would be wrong for intraday bars within the same
 *  session). &gt;0.5% is flagged as a real gap; smaller opens are normal noise, not a gap. */
export function detectGap(bars: Bar[], thresholdPct: number = 0.5): GapResult {
  const days = groupBarsByUTCDay(bars);
  if (days.length < 2) return { type: null, sizePct: null };
  const priorClose = days[days.length - 2][days[days.length - 2].length - 1].close;
  const todayOpen = days[days.length - 1][0].open;
  if (priorClose === 0) return { type: null, sizePct: null };
  const sizePct = ((todayOpen - priorClose) / priorClose) * 100;
  if (Math.abs(sizePct) < thresholdPct) return { type: null, sizePct };
  return { type: sizePct > 0 ? 'GAP_UP' : 'GAP_DOWN', sizePct };
}

export type CandlestickPattern = 'DOJI' | 'HAMMER' | 'SHOOTING_STAR' | 'BULLISH_ENGULFING' | 'BEARISH_ENGULFING' | null;

/** A small, deterministic set of well-known single/two-bar patterns, each defined by real OHLC
 *  ratios (not fabricated pattern-matching) - checked on the most recent 1-2 bars only. Returns
 *  the first pattern that matches (checked in a fixed, documented priority order) or null. */
export function detectCandlestickPattern(bars: Bar[]): CandlestickPattern {
  if (bars.length === 0) return null;
  const cur = bars[bars.length - 1];
  const body = Math.abs(cur.close - cur.open);
  const range = cur.high - cur.low;
  if (range === 0) return null;
  const upperWick = cur.high - Math.max(cur.open, cur.close);
  const lowerWick = Math.min(cur.open, cur.close) - cur.low;

  if (body / range < 0.1) return 'DOJI';
  if (lowerWick > body * 2 && upperWick < body * 0.5) return 'HAMMER';
  if (upperWick > body * 2 && lowerWick < body * 0.5) return 'SHOOTING_STAR';

  if (bars.length >= 2) {
    const prev = bars[bars.length - 2];
    const prevBody = Math.abs(prev.close - prev.open);
    if (prevBody > 0) {
      const prevBearish = prev.close < prev.open;
      const curBullish = cur.close > cur.open;
      if (prevBearish && curBullish && cur.open <= prev.close && cur.close >= prev.open) return 'BULLISH_ENGULFING';
      const prevBullish = prev.close > prev.open;
      const curBearish = cur.close < cur.open;
      if (prevBullish && curBearish && cur.open >= prev.close && cur.close <= prev.open) return 'BEARISH_ENGULFING';
    }
  }
  return null;
}

export interface PriceActionFeatures {
  gap: GapResult;
  consolidating: boolean;
  rangeRegime: 'EXPANDING' | 'CONTRACTING' | 'STABLE' | null;
  candlestick: CandlestickPattern;
}

export function computePriceActionFeatures(bars: Bar[]): PriceActionFeatures {
  return {
    gap: detectGap(bars),
    consolidating: detectConsolidation(bars),
    rangeRegime: rangeExpansionContraction(bars),
    candlestick: detectCandlestickPattern(bars),
  };
}
