import { replaySafety } from './replaySafety';

export type MarketSession = 'PRE_MARKET' | 'REGULAR' | 'AFTER_HOURS' | 'CLOSED';

/** Exported for SessionLifecycle.ts's SessionContext fields (minutesToOpen/SinceOpen/ToClose,
 *  isTradingDay) - reusing this module's own weekday/minute math rather than a 10th independent
 *  reimplementation (see docs/architecture/ARGUS_SESSION_AWARE_TRADING_ARCHITECTURE.md §2.2). */
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

export function sessionAllowsFills(session: MarketSession, extendedHours: boolean): boolean {
  if (session === 'REGULAR') return true;
  if (extendedHours && (session === 'PRE_MARKET' || session === 'AFTER_HOURS')) return true;
  return false;
}
