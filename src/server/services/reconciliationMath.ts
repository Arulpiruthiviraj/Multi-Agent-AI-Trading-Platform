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
