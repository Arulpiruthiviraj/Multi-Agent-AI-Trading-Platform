/**
 * ARGUS Crypto V2 P0 (2026-09-21) - crypto session clock.
 *
 * Equity sessions (src/server/premarket/SessionLifecycle.ts) classify PREMARKET/REGULAR/
 * AFTER_HOURS/CLOSED against America/New_York exchange hours and a holiday calendar. Crypto
 * venues (IBKR crypto, Coinbase, etc.) trade continuously - there is no open/close bell and no
 * holiday calendar to reason about. This module is deliberately NOT a crypto version of
 * SessionLifecycle's state machine; forcing a 24/7 market into an equity-shaped
 * PREMARKET/REGULAR/AFTER_HOURS model would be inventing structure that doesn't exist.
 *
 * What crypto genuinely needs instead is a stable calendar-day boundary for accounting/reporting
 * (daily P&L, daily notional caps, soak-day counting) - this module supplies that as a UTC
 * calendar day, since crypto has no single "home" exchange timezone the way equities have
 * America/New_York. This is pure, deterministic, real-clock-time computation - no market data,
 * no order/position awareness, nothing that could plausibly gate a trade.
 *
 * Isolated, unwired module: no other file imports this yet (see cryptoArchitectureBoundary.test.ts
 * for the same no-OMS/RiskEngine/BrokerManager/ChiefTraderAgent static guarantee already applied
 * to src/server/premarket/ and src/server/multiAsset/).
 */

export interface CryptoSessionSnapshot {
  /** Real wall-clock instant this snapshot was computed from. */
  nowUtc: Date;
  /** UTC calendar day, `YYYY-MM-DD` - the crypto "trading day" boundary. */
  utcDateStr: string;
  /**
   * Always true. Crypto venues never close - this field exists so callers have an explicit,
   * self-documenting invariant to check/assert against rather than an implicit assumption.
   */
  isContinuous: true;
  secondsSinceUtcMidnight: number;
  secondsUntilNextUtcMidnight: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** UTC calendar day as `YYYY-MM-DD`, using UTC field accessors (never local-machine timezone). */
export function getCryptoTradingDateStr(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function getCryptoSessionSnapshot(now: Date = new Date()): CryptoSessionSnapshot {
  const utcDateStr = getCryptoTradingDateStr(now);
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const secondsSinceUtcMidnight = Math.floor((now.getTime() - utcMidnight) / 1000);
  const secondsUntilNextUtcMidnight = Math.floor((utcMidnight + MS_PER_DAY - now.getTime()) / 1000);

  return {
    nowUtc: now,
    utcDateStr,
    isContinuous: true,
    secondsSinceUtcMidnight,
    secondsUntilNextUtcMidnight,
  };
}

/** True when `a` and `b` fall on different UTC calendar days - the crypto day-rollover check. */
export function isCryptoTradingDayRollover(a: Date, b: Date): boolean {
  return getCryptoTradingDateStr(a) !== getCryptoTradingDateStr(b);
}

/**
 * Crypto Expansion Phase 3 (2026-09-21). UTC midnight (ms since epoch) for the calendar day
 * containing `now` - the crypto counterpart to TradingCalendar.ts's getTradingDayStartMs()
 * (America/New_York midnight). Used by RiskEngine.ts to bound its daily-trade-count/
 * daily-buy-notional lookback queries to the correct calendar day for a CRYPTO proposal, instead
 * of silently reusing the equity NY-day boundary (which can start up to several hours into or
 * before a given UTC day depending on DST).
 */
export function getCryptoTradingDayStartMs(now: Date = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}
