import { replaySafety } from './replaySafety';

export type MarketSession = 'PRE_MARKET' | 'REGULAR' | 'AFTER_HOURS' | 'CLOSED';

/** Exported for SessionLifecycle.ts's SessionContext fields (minutesToOpen/SinceOpen/ToClose,
 *  isTradingDay) - reusing this module's own weekday/minute math rather than a 10th independent
 *  reimplementation (see docs/architecture/ARGUS_ARCHITECTURE.md (Premarket / Session-Aware Trading Architecture section) §2.2). */
export function minutesInTimezone(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(new Date(ms));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/** Exported for the same reason as minutesInTimezone above. */
export function weekdayInTimezone(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(ms));
}

export function classifyMarketSession(ms: number, timeZone: string, extendedHours: boolean): MarketSession {
  const wd = weekdayInTimezone(ms, timeZone);
  if (wd === 'Sat' || wd === 'Sun') return 'CLOSED';
  const mins = minutesInTimezone(ms, timeZone);
  const { regularSessionStartMinutes, regularSessionEndMinutes, preMarketStartMinutes, afterHoursEndMinutes } = replaySafety;
  if (mins >= regularSessionStartMinutes && mins < regularSessionEndMinutes) return 'REGULAR';
  if (extendedHours && mins >= preMarketStartMinutes && mins < regularSessionStartMinutes) return 'PRE_MARKET';
  if (extendedHours && mins >= regularSessionEndMinutes && mins < afterHoursEndMinutes) return 'AFTER_HOURS';
  return 'CLOSED';
}

/** 2026-10-04 (opening-range session-anchoring fix): UTC instant of the regular-session open
 *  (`replaySafety.regularSessionStartMinutes`, 9:30 by default) in `timeZone` for the calendar
 *  day containing `dayMs`. DST-safe via the Intl timezone database - no hardcoded EST/EDT
 *  offset. Used to anchor openingRange() at the real regular-session open instead of the
 *  first bar of the UTC day when premarket bars are included in the bar set. */
export function regularSessionOpenMs(dayMs: number, timeZone: string): number {
  const startMinutes = replaySafety.regularSessionStartMinutes;
  const hh = String(Math.floor(startMinutes / 60)).padStart(2, '0');
  const mm = String(startMinutes % 60).padStart(2, '0');
  const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeFormatter = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
  const day = dayFormatter.format(new Date(dayMs));
  const target = Date.parse(`${day}T${hh}:${mm}:00Z`);
  let candidate = target;
  for (let i = 0; i < 3; i++) {
    const d = new Date(candidate);
    const represented = Date.parse(`${dayFormatter.format(d)}T${timeFormatter.format(d)}:00Z`);
    candidate += target - represented;
  }
  return candidate;
}

export function sessionAllowsFills(session: MarketSession, extendedHours: boolean): boolean {
  if (session === 'REGULAR') return true;
  if (extendedHours && (session === 'PRE_MARKET' || session === 'AFTER_HOURS')) return true;
  return false;
}
