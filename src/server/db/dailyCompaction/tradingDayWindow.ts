import { getTradingDateStr, getTradingDayStartMs } from '../../core/TradingCalendar';

/** [windowStartMs, windowEndMs) for one America/New_York trading date, reusing
 *  getTradingDayStartMs() (the single, already-DST-correct source of truth this codebase already
 *  uses for RiskEngine's own day-boundary queries) for BOTH ends - never a second, independent
 *  24h-add calculation that could silently drift out of sync with it across a DST transition. */
export function getTradingDateWindowMs(tradingDate: string): { windowStartMs: number; windowEndMs: number } {
  // Noon UTC anchor avoids any ambiguity near a DST transition instant itself.
  const anchor = new Date(`${tradingDate}T12:00:00Z`);
  const windowStartMs = getTradingDayStartMs(anchor);
  const nextDayAnchor = new Date(anchor.getTime() + 24 * 60 * 60 * 1000);
  const windowEndMs = getTradingDayStartMs(nextDayAnchor);
  return { windowStartMs, windowEndMs };
}

/** A trading date is "closed" (eligible for compaction) only once the real wall clock has fully
 *  passed its window end - never compact today / the currently-active day. */
export function isTradingDateClosed(tradingDate: string, nowMs: number): boolean {
  const { windowEndMs } = getTradingDateWindowMs(tradingDate);
  return nowMs >= windowEndMs;
}

/** Today's real America/New_York trading date, by the SAME getTradingDateStr() every other
 *  daily-boundary concept in this codebase already uses. */
export function todayTradingDateStr(nowMs: number): string {
  return getTradingDateStr(new Date(nowMs));
}
