/**
 * DATA → DATA QUALITY → BACKTEST. Never skip this gate for promotion.
 * Never fabricate missing bars. Gaps are counted, not filled.
 */
import { researchSafety } from '../config/researchSafety';
import type { CanonicalDataset, DataQualityGrade, ResearchBar } from './ohlcvTypes';

export interface DataQualityReport {
  quality: DataQualityGrade;
  issues: string[];
  backtestAllowed: boolean;
  paperPromotionAllowed: boolean;
  liveCandidateAllowed: boolean;
  droppedBarCount?: number;
  missingIntervalCount?: number;
}

function validOhlc(b: ResearchBar): boolean {
  if (!(b.high >= b.low)) return false;
  if (!(b.open >= b.low && b.open <= b.high)) return false;
  if (!(b.close >= b.low && b.close <= b.high)) return false;
  if (b.open <= 0 || b.high <= 0 || b.low <= 0 || b.close <= 0) return false;
  return true;
}

export function expectedStepMs(frequency: string): number | null {
  const f = frequency.toLowerCase();
  if (f === '1min' || f === '1m') return 60_000;
  if (f === '5min' || f === '5m') return 300_000;
  if (f === '15min' || f === '15m') return 900_000;
  if (f === '1hour' || f === '1h' || f === '60min') return 3_600_000;
  if (f === '1day' || f === '1d' || f === 'day') return 86_400_000;
  return null;
}

/** Count holes. Overnight / weekend gaps are not treated as missing for intraday/daily. */
export function countMissingIntervals(bars: ResearchBar[], frequency: string): number {
  if (bars.length < 2) return 0;
  const step = expectedStepMs(frequency);
  if (!step) return 0;
  const ordered = [...bars].sort((a, b) => a.timestamp - b.timestamp);
  let missing = 0;
  const daily = step === 86_400_000;
  for (let i = 1; i < ordered.length; i++) {
    const gap = ordered[i].timestamp - ordered[i - 1].timestamp;
    if (daily) {
      const days = gap / 86_400_000;
      if (days > 4) missing += Math.max(0, Math.round(days) - 1);
      continue;
    }
    if (gap >= 8 * 3_600_000) continue;
    if (gap > step * 2) missing += Math.max(0, Math.round(gap / step) - 1);
  }
  return missing;
}

export function assessDataQuality(ds: CanonicalDataset, extras?: { droppedBarCount?: number }): DataQualityReport {
  const issues: string[] = [];
  const bars = ds.bars ?? [];
  const droppedBarCount = extras?.droppedBarCount ?? 0;
  if (bars.length === 0) {
    return {
      quality: 'RED',
      issues: ['empty_dataset'],
      backtestAllowed: false,
      paperPromotionAllowed: false,
      liveCandidateAllowed: false,
      droppedBarCount,
      missingIntervalCount: 0,
    };
  }

  const seen = new Set<number>();
  let dup = 0;
  let missingOhlc = 0;
  let invalidOhlc = 0;
  let badVolume = 0;
  let unsorted = false;
  let prev = -Infinity;
  for (const b of bars) {
    if (seen.has(b.timestamp)) dup += 1;
    seen.add(b.timestamp);
    if (b.timestamp < prev) unsorted = true;
    prev = b.timestamp;
    if ([b.open, b.high, b.low, b.close].some((x) => !Number.isFinite(x))) missingOhlc += 1;
    else if (!validOhlc(b)) invalidOhlc += 1;
    if (!Number.isFinite(b.volume) || b.volume < 0) badVolume += 1;
    else if (b.volume === 0) issues.push('zero_volume_bar');
  }

  const missingIntervalCount = countMissingIntervals(bars, ds.frequency);
  if (dup > 0) issues.push('duplicate_timestamps');
  if (unsorted) issues.push('unsorted_timestamps');
  if (missingOhlc > 0) issues.push('missing_ohlc');
  if (invalidOhlc > 0) issues.push('invalid_ohlc_relationship');
  if (badVolume > 0) issues.push('suspicious_volume');
  if (!ds.timezone) issues.push('timezone_missing');
  if (ds.market === 'CA' || ds.market === 'CANADA') issues.push('canadian_live_blocked');
  if (droppedBarCount > 0) issues.push('bars_dropped_before_grade');
  if (missingIntervalCount >= researchSafety.missingIntervalYellowCount) issues.push('missing_intervals');

  const red =
    dup > 0 ||
    missingOhlc > 0 ||
    invalidOhlc > 0 ||
    badVolume > 0 ||
    missingIntervalCount >= researchSafety.missingIntervalRedCount ||
    issues.includes('empty_dataset');
  const yellow = !red && (
    unsorted ||
    issues.includes('zero_volume_bar') ||
    issues.includes('timezone_missing') ||
    issues.includes('missing_intervals') ||
    droppedBarCount > 0
  );
  const quality: DataQualityGrade = red ? 'RED' : yellow ? 'YELLOW' : 'GREEN';

  const uniqueIssues = [...new Set(issues)];
  return {
    quality,
    issues: uniqueIssues,
    backtestAllowed: quality !== 'RED',
    paperPromotionAllowed: quality === 'GREEN',
    liveCandidateAllowed: false,
    droppedBarCount,
    missingIntervalCount,
  };
}
