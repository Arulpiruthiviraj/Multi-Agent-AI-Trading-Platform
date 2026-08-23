/**
 * NewsEngine poll cadence: RTH vs off-hours (24/7 ingestion, conservation overnight).
 * Order placement remains RiskEngine market_hours gated — this only affects news polling.
 */
import { classifyMarketSession } from '../replay/marketSession';
import { TRADING_TIMEZONE } from '../core/TradingCalendar';
import { runtimeIntervals } from '../config/runtimeIntervals';

export function isUsEquityRegularSession(nowMs = Date.now()): boolean {
  return classifyMarketSession(nowMs, TRADING_TIMEZONE, false) === 'REGULAR';
}

/** Active RTH cadence vs off-hours conservation interval from runtimeIntervals.json. */
export function resolveNewsEnginePollMs(nowMs = Date.now()): number {
  return isUsEquityRegularSession(nowMs)
    ? runtimeIntervals.newsEngineMs
    : runtimeIntervals.newsEngineOffHoursMs;
}
