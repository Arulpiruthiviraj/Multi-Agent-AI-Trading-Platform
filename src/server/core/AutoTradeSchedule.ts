/**
 * Pure HH:MM window-comparison logic for the scheduled-auto-trading feature, kept separate from
 * AutoTradeScheduler.ts (the background timer/DB/TradingEngine side) so the actual decision rule
 * is unit-testable without a DB, a clock mock, or a running server.
 *
 * Deliberately same-day only (start < end, e.g. "09:30"-"16:00"): NYSE/NASDAQ regular sessions
 * never cross midnight, and a wraparound window ("22:00"-"06:00") would be a materially different
 * feature (needs its own day-boundary handling) that nobody asked for. isWithinScheduledWindow
 * treats a misconfigured start >= end as "never in window" rather than guessing which side the
 * user meant - fail closed, not fail creative.
 */

const HHMM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidHHMM(value: unknown): value is string {
  return typeof value === 'string' && HHMM_PATTERN.test(value);
}

// No hardcoded allowlist - delegates to the ICU timezone database Node already ships (the same
// one getTimeHHMMInZone uses to actually compute the time), so this can never drift out of date
// against real IANA tzdata updates the way a hand-maintained list of zone strings would.
export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// "HH:MM" strings compare correctly with plain string comparison because they're fixed-width and
// zero-padded (validated by isValidHHMM before this is ever called) - no need to parse to minutes.
export function isWithinScheduledWindow(nowHHMM: string, startHHMM: string, endHHMM: string): boolean {
  if (!isValidHHMM(nowHHMM) || !isValidHHMM(startHHMM) || !isValidHHMM(endHHMM)) return false;
  if (startHHMM >= endHHMM) return false;
  return nowHHMM >= startHHMM && nowHHMM < endHHMM;
}
