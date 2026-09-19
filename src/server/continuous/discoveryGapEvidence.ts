import { getTradingDateStr } from '../core/TradingCalendar';

export interface DiscoveryGapEvidence {
  source: 'ALPACA_IEX_SNAPSHOT';
  price: number;
  open: unknown;
  previousClose: unknown;
  priceTimestamp: unknown;
  openTimestamp: unknown;
  previousCloseTimestamp: unknown;
  high: unknown;
  low: unknown;
  corporateActionState: 'UNKNOWN';
}

/** Intraday return from the same session's open, not an overnight gap.
 * No magnitude cutoff: a large move alone is not evidence of corrupt data.
 */
export function validateDiscoveryGap(e: DiscoveryGapEvidence, nowMs = Date.now()): { gapPct: number | null; reason: string } {
  const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (![e.price, e.open, e.previousClose, e.high, e.low].every(positive)) {
    return { gapPct: null, reason: 'INVALID_REFERENCE_PRICE' };
  }
  const timestamps = [e.priceTimestamp, e.openTimestamp, e.previousCloseTimestamp]
    .map(t => typeof t === 'string' ? Date.parse(t) : NaN);
  if (!timestamps.every(Number.isFinite)) return { gapPct: null, reason: 'REFERENCE_TIMESTAMP_UNAVAILABLE' };
  const [priceAt, openAt, prevAt] = timestamps;
  const day = getTradingDateStr(new Date(nowMs));
  if (priceAt > nowMs || openAt > priceAt || prevAt >= openAt
      || getTradingDateStr(new Date(openAt)) !== day
      || getTradingDateStr(new Date(priceAt)) !== day
      || getTradingDateStr(new Date(prevAt)) >= day) {
    return { gapPct: null, reason: 'STALE_OR_INCONSISTENT_REFERENCE_TIMESTAMP' };
  }
  const open = e.open as number, low = e.low as number, high = e.high as number;
  if (low > high || open < low || open > high) return { gapPct: null, reason: 'OPEN_OUTSIDE_SESSION_RANGE' };
  // Previous close is retained for audit only; unknown corporate actions must not
  // justify a cross-session ratio filter or an invented split adjustment.
  return { gapPct: (e.price - open) / open, reason: 'VALID_SAME_SESSION_INTRADAY_RETURN' };
}
