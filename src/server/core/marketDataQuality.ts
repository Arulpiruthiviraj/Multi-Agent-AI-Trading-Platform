/**
 * Quote freshness for live/paper risk. Null age is UNKNOWN, never GREEN.
 * Persist via RiskEngine risk_gate_results detail (grade, priceAgeMs).
 */
import { tradingSafety } from '../config/tradingSafety';

export type MarketDataGrade = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';

export interface QuoteFreshnessResult {
  grade: MarketDataGrade;
  passed: boolean;
  priceAgeMs: number | null;
  thresholdMs: number;
  reason: string;
}

export function evaluateQuoteFreshness(opts: {
  priceAgeMs: number | null;
  staleThresholdMs?: number;
}): QuoteFreshnessResult {
  const thresholdMs = opts.staleThresholdMs ?? tradingSafety.stalePriceThresholdMs;
  const priceAgeMs = opts.priceAgeMs;
  if (priceAgeMs === null || !Number.isFinite(priceAgeMs) || priceAgeMs < 0) {
    return {
      grade: 'UNKNOWN',
      passed: false,
      priceAgeMs: priceAgeMs === null ? null : priceAgeMs,
      thresholdMs,
      reason: 'UNKNOWN_FRESHNESS: no tick age for this symbol. Null age is not treated as fresh. No new order until a real tick is observed.',
    };
  }
  if (priceAgeMs > thresholdMs) {
    return {
      grade: 'RED',
      passed: false,
      priceAgeMs,
      thresholdMs,
      reason: `Stale market data: last real tick is ${Math.round(priceAgeMs / 1000)}s old (threshold ${thresholdMs / 1000}s).`,
    };
  }
  const yellowBand = Math.max(1, Math.floor(thresholdMs / 2));
  const grade: MarketDataGrade = priceAgeMs > yellowBand ? 'YELLOW' : 'GREEN';
  return {
    grade,
    passed: true,
    priceAgeMs,
    thresholdMs,
    reason: `Last tick ${priceAgeMs}ms ago (grade=${grade}).`,
  };
}
