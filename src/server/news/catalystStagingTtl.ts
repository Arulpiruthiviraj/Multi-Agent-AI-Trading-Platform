/**
 * TTL helpers for overnight / after-hours news catalysts staged for the next RTH open.
 */
import { TRADING_TIMEZONE, getTradingDateStr } from '../core/TradingCalendar';
import { runtimeIntervals } from '../config/runtimeIntervals';

function etParts(ms: number): { y: number; m: number; d: number; mins: number; wd: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TRADING_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    mins: Number(get('hour')) * 60 + Number(get('minute')),
    wd: get('weekday'),
  };
}

/** Instant (UTC ms) for a given America/New_York calendar Y-M-D at minutes-since-midnight. */
export function etWallClockToUtcMs(y: number, m: number, d: number, minsSinceMidnight: number): number {
  const hh = Math.floor(minsSinceMidnight / 60);
  const mm = minsSinceMidnight % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  // Interpret as ET local via Date parsing with explicit offset probe — use noon UTC guess then adjust.
  const guess = Date.parse(`${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:00`);
  // Refine: format guess in ET and compare wall clock
  let t = Number.isFinite(guess) ? guess : Date.now();
  for (let i = 0; i < 3; i++) {
    const p = etParts(t);
    const want = minsSinceMidnight;
    const got = p.mins;
    const dayDelta =
      Date.UTC(y, m - 1, d) - Date.UTC(p.y, p.m - 1, p.d);
    t += dayDelta + (want - got) * 60_000;
  }
  return t;
}

export type CatalystHorizonClass = 'INTRADAY' | 'MULTI_DAY' | 'MULTI_WEEK';

export function classifyCatalystHorizon(expectedHorizon: string | null | undefined): CatalystHorizonClass {
  const h = String(expectedHorizon || 'INTRADAY').toUpperCase();
  if (h.includes('WEEK') || h.includes('1-2W') || h.includes('2W')) return 'MULTI_WEEK';
  if (h.includes('1-3D') || h.includes('DAY') || h.includes('3D') || h.includes('SWING')) return 'MULTI_DAY';
  return 'INTRADAY';
}

/**
 * Expiry for staged catalysts.
 * INTRADAY → 10:30 ET of the next regular session (or same session if still before 10:30).
 * MULTI_DAY → +3 calendar days; MULTI_WEEK → +14 calendar days.
 */
export function computeCatalystExpiresAtMs(
  nowMs: number,
  expectedHorizon: string | null | undefined,
): number {
  const klass = classifyCatalystHorizon(expectedHorizon);
  if (klass === 'MULTI_DAY') return nowMs + 3 * 24 * 60 * 60 * 1000;
  if (klass === 'MULTI_WEEK') return nowMs + 14 * 24 * 60 * 60 * 1000;

  const untilMins = runtimeIntervals.newsIntradayStageUntilEtMinutes;
  const p = etParts(nowMs);
  // If already in RTH before cutoff, expire today at cutoff; else next weekday at cutoff.
  let y = p.y;
  let m = p.m;
  let d = p.d;
  const isWeekday = p.wd !== 'Sat' && p.wd !== 'Sun';
  if (isWeekday && p.mins < untilMins) {
    return etWallClockToUtcMs(y, m, d, untilMins);
  }
  // Advance to next weekday
  let cursor = new Date(Date.UTC(y, m - 1, d + 1));
  for (let i = 0; i < 8; i++) {
    const iso = cursor.toISOString();
    const probe = Date.parse(iso.slice(0, 10) + 'T16:00:00.000Z'); // rough midday UTC
    const wp = etParts(probe);
    if (wp.wd !== 'Sat' && wp.wd !== 'Sun') {
      return etWallClockToUtcMs(wp.y, wp.m, wp.d, untilMins);
    }
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() + 1));
  }
  return nowMs + 24 * 60 * 60 * 1000;
}

export function nextSessionOpenLabel(nowMs = Date.now()): string {
  return getTradingDateStr(new Date(nowMs));
}
