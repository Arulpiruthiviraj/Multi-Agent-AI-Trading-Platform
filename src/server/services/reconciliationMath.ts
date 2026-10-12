import { classifyMarketSession } from '../replay/marketSession';
/**
 * Pure reconciliation math helpers (no DB, no broker, no config, no side effects).
 *
 * Extracted 2026-10-05 so the fail-closed dollar-impact logic is unit-testable
 * without importing PortfolioReconciliation's heavy module graph.
 */

/**
 * 2026-10-05 P1 fix: `qty * price` with a missing/non-finite price is NaN, and NaN poisons
 * Math.max() — worstImpact becomes NaN, `NaN >= threshold` is false, and a CONFIRMED
 * divergence can never trip the pause. A divergence whose dollar size cannot be computed
 * must fail CLOSED (trip the gate), never slip through as NaN.
 *
 * `fallbackDollars` is the significant-mismatch threshold (from tradingSafety); returning it
 * guarantees the pause gate trips on unpriceable divergences.
 */
export function safeDollarImpact(qty: number, price: number | null | undefined, fallbackDollars: number): number {
  const q = typeof qty === 'number' && Number.isFinite(qty) ? Math.abs(qty) : 0;
  const p = typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : NaN;
  const impact = q * p;
  return Number.isFinite(impact) && impact > 0 ? impact : fallbackDollars;
}

/**
 * 2026-10-12: a held position has no fresh live mark outside US trading hours (the tick feed is idle),
 * so "valuation unavailable" there is EXPECTED, not an account discrepancy. It used to confirm after two
 * overnight cycles, pause trading (and Autobot) and leave the next session unable to trade or exit.
 * Only the session CLOSED window (weekend, before pre-market, after after-hours; holiday-blind like every
 * other session representation here) is exempt; PRE_MARKET, REGULAR and AFTER_HOURS still escalate.
 * Quantity / fill-ledger conflicts are unaffected.
 */
export function valuationMarksExpectedUnavailable(nowMs: number): boolean {
  return classifyMarketSession(nowMs, 'America/New_York', true) === 'CLOSED';
}
