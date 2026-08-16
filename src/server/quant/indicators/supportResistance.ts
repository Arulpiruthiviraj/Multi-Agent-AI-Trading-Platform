/**
 * ==========================================================
 * Module: indicators/supportResistance
 *
 * Purpose:
 * Support/resistance-family features: previous-day H/L/C, opening range, swing H/L (reuses
 * trend.ts's real fractal detectSwingPoints - not a second implementation), daily/weekly H/L,
 * floor pivot points, Fibonacci retracement (calls the existing, previously-dead
 * TechnicalIndicators.calculateFibonacciRetracement - this is the first real caller it's ever
 * had, confirmed via repo-wide grep before writing this), and distance-to-level helpers.
 *
 * Premarket H/L is honestly gated: Argus's real historical bars (ohlcv_bars, via
 * HistoricalDataGateway) are predominantly daily-granularity in practice. `premarketHighLow`
 * below detects when the supplied bars are too coarse (≈24h spacing) to resolve a premarket
 * window at all and returns `available:false` with a stated reason, rather than fabricating a
 * value from daily bars - directly per this plan's "do not invent unavailable data" requirement.
 * ==========================================================
 */
import { TechnicalIndicators } from '../../engines/TechnicalIndicators';
import { Bar } from '../../engines/backtest/HistoricalDataGateway';
import { detectSwingPoints, SwingPoint } from './trend';
import { quantExperimentalStrategies } from '../../config/quantExperimentalStrategies';

function utcDayKey(timestampMs: number): string {
  const d = new Date(timestampMs);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

/** Groups bars by their UTC calendar day, preserving chronological order of the groups. */
export function groupBarsByUTCDay(bars: Bar[]): Bar[][] {
  const groups = new Map<string, Bar[]>();
  for (const bar of bars) {
    const key = utcDayKey(bar.timestamp);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(bar);
  }
  return Array.from(groups.values());
}

export interface OHLC { high: number; low: number; close: number }

/** The most recently COMPLETED calendar day's high/low/close - i.e. the day before whichever day
 *  the last bar belongs to, not simply "the second-to-last bar" (which would be wrong for
 *  intraday bars where many bars share the current day). Null if fewer than 2 distinct days exist. */
export function previousDayLevels(bars: Bar[]): OHLC | null {
  const days = groupBarsByUTCDay(bars);
  if (days.length < 2) return null;
  const previousDay = days[days.length - 2];
  const high = Math.max(...previousDay.map(b => b.high));
  const low = Math.min(...previousDay.map(b => b.low));
  const close = previousDay[previousDay.length - 1].close;
  return { high, low, close };
}

/** True if consecutive bars are ~24h apart (daily-granularity data) - used to honestly detect
 *  when intraday-only features (opening range, premarket) cannot be resolved from what's available. */
function looksDailyGranularity(bars: Bar[]): boolean {
  if (bars.length < 2) return true;
  const gaps: number[] = [];
  for (let i = 1; i < Math.min(bars.length, 6); i++) gaps.push(bars[i].timestamp - bars[i - 1].timestamp);
  const avgGapHours = (gaps.reduce((a, b) => a + b, 0) / gaps.length) / (60 * 60 * 1000);
  return avgGapHours >= 20; // real trading days are ~23-24h apart including weekends compressed out
}

export interface AvailabilityTagged<T> {
  available: boolean;
  reason?: string;
  data: T | null;
}

/** Real high/low of the current session's bars within `windowMinutes` of the session start
 *  (default 30, i.e. the classic "opening range"). Honestly reports unavailable on daily-
 *  granularity bars rather than fabricating a range from a single daily candle. */
export function openingRange(bars: Bar[], windowMinutes: number = 30): AvailabilityTagged<{ high: number; low: number }> {
  if (looksDailyGranularity(bars)) {
    return { available: false, reason: 'Only daily-granularity bars available - opening range requires intraday bars.', data: null };
  }
  const days = groupBarsByUTCDay(bars);
  if (days.length === 0) return { available: false, reason: 'No bars.', data: null };
  const currentDay = days[days.length - 1];
  const sessionStart = currentDay[0].timestamp;
  const windowEnd = sessionStart + windowMinutes * 60 * 1000;
  const rangeBars = currentDay.filter(b => b.timestamp <= windowEnd);
  if (rangeBars.length === 0) return { available: false, reason: 'No bars within the opening-range window yet.', data: null };
  return { available: true, data: { high: Math.max(...rangeBars.map(b => b.high)), low: Math.min(...rangeBars.map(b => b.low)) } };
}

/** Premarket high/low, restricted to bars strictly before `regularSessionStartMs` on the current
 *  day. Caller supplies the real regular-session-open timestamp (this module makes no US-market-
 *  hours/timezone/DST assumption of its own) - honestly unavailable on daily bars or when no
 *  premarket bars exist in the supplied window. */
export function premarketHighLow(bars: Bar[], regularSessionStartMs: number): AvailabilityTagged<{ high: number; low: number }> {
  if (looksDailyGranularity(bars)) {
    return { available: false, reason: 'Only daily-granularity bars available - premarket range requires intraday bars.', data: null };
  }
  const premarketBars = bars.filter(b => b.timestamp < regularSessionStartMs);
  if (premarketBars.length === 0) {
    return { available: false, reason: 'No bars before the supplied regular-session-start timestamp.', data: null };
  }
  return { available: true, data: { high: Math.max(...premarketBars.map(b => b.high)), low: Math.min(...premarketBars.map(b => b.low)) } };
}

/** High/low over the trailing `lookback` bars. Assumes the caller has passed bars at the
 *  granularity they mean by "daily"/"weekly" (this module does not resample) - `dailyHighLow`/
 *  `weeklyHighLow` below are thin, explicitly-documented convenience wrappers over this. */
export function rollingHighLow(bars: Bar[], lookback: number): OHLC | null {
  if (bars.length < lookback) return null;
  const window = bars.slice(-lookback);
  return { high: Math.max(...window.map(b => b.high)), low: Math.min(...window.map(b => b.low)), close: window[window.length - 1].close };
}

/** Assumes `bars` are daily bars (Argus's real backtest/ohlcv_bars default timeframe) - `days`
 *  trailing daily bars. Pass real intraday bars grouped/resampled to daily yourself if needed. */
export function dailyHighLow(bars: Bar[], days: number = 1): OHLC | null {
  return rollingHighLow(bars, days);
}

/** Assumes `bars` are daily bars - `weeks * 5` trailing trading-day bars as an approximation of
 *  calendar weeks (5 trading days/week, ignoring holidays - a real, disclosed simplification). */
export function weeklyHighLow(bars: Bar[], weeks: number = 1): OHLC | null {
  return rollingHighLow(bars, weeks * 5);
}

/** Real fractal swing highs/lows over the supplied bars - delegates to trend.ts's
 *  detectSwingPoints rather than a second implementation. */
export function swingHighsLows(bars: Bar[], lookback: number = 2): SwingPoint[] {
  return detectSwingPoints(bars, lookback);
}

export interface PivotPoints {
  pivot: number; r1: number; r2: number; r3: number; s1: number; s2: number; s3: number;
}

/** Standard floor-trader pivot points from the previous period's H/L/C. */
export function calculatePivotPoints(prevHigh: number, prevLow: number, prevClose: number): PivotPoints {
  const pivot = (prevHigh + prevLow + prevClose) / 3;
  const range = prevHigh - prevLow;
  return {
    pivot,
    r1: 2 * pivot - prevLow, s1: 2 * pivot - prevHigh,
    r2: pivot + range, s2: pivot - range,
    r3: prevHigh + 2 * (pivot - prevLow), s3: prevLow - 2 * (prevHigh - pivot),
  };
}

export interface LevelDistance { level: number; abs: number; pct: number }

export function distanceToLevel(currentPrice: number, level: number | null): LevelDistance | null {
  if (level === null || level === 0) return null;
  const abs = currentPrice - level;
  return { level, abs, pct: (abs / level) * 100 };
}

/** Given a set of candidate resistance levels (above price) and support levels (below price),
 *  returns the nearest of each - a real, useful "distance to support/resistance" that considers
 *  every level this module can compute (swings, pivots, previous-day levels), not just one. */
export function nearestSupportResistance(currentPrice: number, candidateLevels: number[]): { nearestResistance: LevelDistance | null; nearestSupport: LevelDistance | null } {
  const above = candidateLevels.filter(l => l > currentPrice).sort((a, b) => a - b);
  const below = candidateLevels.filter(l => l < currentPrice).sort((a, b) => b - a);
  return {
    nearestResistance: above.length ? distanceToLevel(currentPrice, above[0]) : null,
    nearestSupport: below.length ? distanceToLevel(currentPrice, below[0]) : null,
  };
}

export interface SupportResistanceFeatures {
  previousDay: OHLC | null;
  dailyHighLow: OHLC | null;
  weeklyHighLow: OHLC | null;
  pivots: PivotPoints | null;
  fibonacci: ReturnType<typeof TechnicalIndicators.calculateFibonacciRetracement> | null;
  recentSwings: SwingPoint[];
  nearest: { nearestResistance: LevelDistance | null; nearestSupport: LevelDistance | null };
  /** Classic opening range. `available:false` on daily bars — never fabricated from a daily candle. */
  openingRange: AvailabilityTagged<{ high: number; low: number }>;
  /**
   * High/low of the prior `donchianPriorLookback` bars excluding the current bar (Donchian-style
   * breakout reference). Null when there are not enough prior bars. Distinct from `dailyHighLow`,
   * which includes the current bar so close cannot exceed the window high.
   */
  priorChannel20: OHLC | null;
}

export function computeSupportResistanceFeatures(bars: Bar[]): SupportResistanceFeatures {
  const currentPrice = bars.length ? bars[bars.length - 1].close : 0;
  const prevDay = previousDayLevels(bars);
  const lookback = quantExperimentalStrategies.thresholds.donchianPriorLookback;
  const daily = dailyHighLow(bars, lookback);
  const weekly = weeklyHighLow(bars, 4);
  const pivots = prevDay ? calculatePivotPoints(prevDay.high, prevDay.low, prevDay.close) : null;
  const fibonacci = daily ? TechnicalIndicators.calculateFibonacciRetracement(daily.high, daily.low) : null;
  const swings = swingHighsLows(bars).slice(-10);
  const orWindow = quantExperimentalStrategies.thresholds.openingRangeWindowMinutes;
  const priorBars = bars.length > 1 ? bars.slice(0, -1) : [];

  const candidateLevels = [
    ...(prevDay ? [prevDay.high, prevDay.low] : []),
    ...(pivots ? [pivots.r1, pivots.r2, pivots.s1, pivots.s2] : []),
    ...swings.map(s => s.price),
  ];

  return {
    previousDay: prevDay,
    dailyHighLow: daily,
    weeklyHighLow: weekly,
    pivots,
    fibonacci,
    recentSwings: swings,
    nearest: nearestSupportResistance(currentPrice, candidateLevels),
    openingRange: openingRange(bars, orWindow),
    priorChannel20: rollingHighLow(priorBars, lookback),
  };
}
