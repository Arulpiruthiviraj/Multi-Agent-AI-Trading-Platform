/**
 * ==========================================================
 * Module: TradingCalendar.ts
 *
 * Hardening pass, Phase 3 (daily-loss timezone boundary). RiskEngine.ts's daily-loss circuit
 * breaker previously computed "today" as `new Date().toISOString().split('T')[0]` - real UTC
 * midnight, not the real exchange's (NYSE/NASDAQ) midnight. Since America/New_York is UTC-5 (EST)
 * or UTC-4 (EDT) depending on the time of year, UTC midnight lands at 7 or 8 PM New York time -
 * the daily-loss baseline was resetting mid-afternoon/evening US trading hours, not at the actual
 * start of the trading day. A naive fixed UTC-4/UTC-5 offset would itself be wrong twice a year
 * (DST transitions don't happen on a fixed calendar schedule), so this uses the real IANA
 * `America/New_York` timezone database via `Intl.DateTimeFormat`, which resolves DST correctly
 * without any manual offset table.
 *
 * Deliberately narrow scope: only calendar-day/session-boundary calculations use this. Every
 * stored timestamp in the schema (`submittedAt`, `timestamp`, `filledAt`, etc.) stays real UTC
 * ISO-8601, unchanged - this never touches how anything is persisted, only how "which trading day
 * is this" is decided.
 * ==========================================================
 */

export const TRADING_TIMEZONE = 'America/New_York';

const tradingDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TRADING_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Returns the real trading-exchange calendar date (YYYY-MM-DD, America/New_York) for the given
// instant - not the UTC calendar date, which can be a different day for several hours around
// each exchange midnight. `en-CA` formats as YYYY-MM-DD directly; DST is resolved by the ICU
// timezone database, not a hardcoded offset.
export function getTradingDateStr(date: Date = new Date()): string {
  return tradingDateFormatter.format(date);
}

const tradingTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TRADING_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

// Returns the real exchange-local wall-clock time (HH:MM, 24h, America/New_York) for the given
// instant. Same DST rationale as getTradingDateStr above - used by AutoTradeSchedule.ts to compare
// against a user-configured HH:MM trading window without a manual EST/EDT offset table. `en-GB`
// with hour12:false gives zero-padded 24h HH:MM directly.
export function getTradingTimeHHMM(date: Date = new Date()): string {
  return tradingTimeFormatter.format(date);
}
