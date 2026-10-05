/**
 * ==========================================================
 * Module: DailyBuyNotional
 *
 * Cumulative BUY dollars deployed on the current America/New_York trading day
 * (FILLED + still-open BUY rows). Distinct from daily-loss kill-switch.
 *
 * Paper: tradingSafety.maxDailyBuyNotionalDollars (reviewed; 0 would mean uncapped — do not ship 0).
 * LIVE: always clamped by restrictedLiveMaxDailyBuyNotionalDollars (file-reviewed, not a UI knob).
 * ==========================================================
 */
import { tradingSafety } from '../config/tradingSafety';
import { getTradingDateStr } from '../core/TradingCalendar';

const COUNTABLE_BUY_STATUSES = new Set([
  'PENDING', 'ACCEPTED', 'PARTIALLY_FILLED', 'FILLED',
]);

export function resolveDailyBuyNotionalCap(tradingMode: string | undefined | null): number | null {
  const paperCap = tradingSafety.maxDailyBuyNotionalDollars;
  if (tradingMode === 'LIVE') {
    const liveCap = tradingSafety.restrictedLiveMaxDailyBuyNotionalDollars;
    return paperCap > 0 ? Math.min(paperCap, liveCap) : liveCap;
  }
  // 2026-10-05 P1 fix: a zero/negative/misconfigured paper cap previously resolved to null,
  // which evaluateDailyBuyNotional() reads as "skip the cap" — fail OPEN to uncapped daily
  // buying (the header's "0 would mean uncapped — do not ship 0" was aspirational, not
  // enforced). Fail closed instead: 0 blocks every BUY (projected > 0 can never be <= 0).
  if (!(paperCap > 0)) {
    console.error(`[DailyBuyNotional] maxDailyBuyNotionalDollars is misconfigured (${paperCap}) — failing CLOSED: daily buy cap = $0 (all BUYs blocked) until fixed.`);
    return 0;
  }
  return paperCap;
}

export function sumDailyBuyNotional(
  rows: Array<{ side?: string; status?: string; price?: number; quantity?: number; timestamp?: string }>,
  todayNy: string = getTradingDateStr(),
): number {
  let sum = 0;
  for (const t of rows) {
    if (t.side !== 'BUY') continue;
    if (!t.status || !COUNTABLE_BUY_STATUSES.has(t.status)) continue;
    const day = t.timestamp ? getTradingDateStr(new Date(t.timestamp)) : '';
    if (day !== todayNy) continue;
    const px = Number(t.price);
    const qty = Number(t.quantity);
    // 2026-10-05 P1 fix: skip non-positive price/quantity rows (data corruption or a SELL
    // mislabeled as BUY) — a negative px*qty previously SUBTRACTED from the deployed total,
    // making the cap think less was spent than actually was. Matches snapshotCapital()'s
    // positive-only convention.
    if (!Number.isFinite(px) || !Number.isFinite(qty) || px <= 0 || qty <= 0) continue;
    sum += px * qty;
  }
  return sum;
}

export function evaluateDailyBuyNotional(input: {
  cap: number | null;
  side: 'BUY' | 'SELL';
  alreadyDeployed: number;
  requestedNotional: number;
}): { passed: boolean; skipped: boolean; cap: number | null; alreadyDeployed: number; requestedNotional: number; projected: number; reason?: string } {
  if (input.cap == null || input.side !== 'BUY') {
    return {
      passed: true,
      skipped: true,
      cap: input.cap,
      alreadyDeployed: input.alreadyDeployed,
      requestedNotional: input.requestedNotional,
      projected: input.alreadyDeployed,
    };
  }
  const projected = input.alreadyDeployed + input.requestedNotional;
  const passed = projected <= input.cap;
  return {
    passed,
    skipped: false,
    cap: input.cap,
    alreadyDeployed: input.alreadyDeployed,
    requestedNotional: input.requestedNotional,
    projected,
    reason: passed
      ? undefined
      : `Daily buy notional cap: already deployed $${input.alreadyDeployed.toFixed(2)} plus requested $${input.requestedNotional.toFixed(2)} = $${projected.toFixed(2)}, which exceeds the $${input.cap.toFixed(2)} cap (distinct from the daily-loss kill-switch).`,
  };
}
