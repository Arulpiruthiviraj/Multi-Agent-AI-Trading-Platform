/**
 * ==========================================================
 * Module: Commissions
 *
 * Purpose:
 * Phase 2B of FINAL_ANALYSIS.md's 4-phase remediation plan - real trading-cost drag for the
 * backtest engine, which previously modeled none (FINAL_ANALYSIS.md 15.9). Broker commission
 * itself defaults to $0, matching Alpaca's real equity commission structure (the app's only fully
 * real, unattended broker) - but the two real regulatory pass-through fees every US equity SELL
 * actually incurs, regardless of broker, are modeled with verified current rates:
 *
 *   - SEC Section 31 fee: $20.60 per $1,000,000 of principal, SELLS ONLY, rounded up to the
 *     nearest cent. Verified via FINRA's official rate notice (effective April 4, 2026) - not
 *     assumed or carried forward from stale training data.
 *   - FINRA Trading Activity Fee (TAF): $0.000195 per share, SELLS ONLY, minimum $0.01, capped at
 *     $9.79 per trade. Verified via FINRA's own published 2026 rate.
 *
 * Both confirmed against Alpaca's own regulatory-fees support page, which describes the same
 * sells-only SEC/FINRA structure for the real broker this backtest exists to approximate.
 *
 * Sources: https://www.finra.org/rules-guidance/notices/information-notice-20260317 ·
 * https://www.finra.org/rules-guidance/guidance/trading-activity-fee ·
 * https://alpaca.markets/support/regulatory-fees
 *
 * Not modeled, disclosed rather than silently omitted: a CAT (Consolidated Audit Trail) fee that
 * Alpaca's own fee-schedule page mentions applies to both buys and sells "in addition to the
 * existing REG/TAF fee" - its exact current rate is not published on that page and was not found
 * verified elsewhere during this pass, so it is left out rather than guessed at.
 * ==========================================================
 */

export const SEC_FEE_RATE_PER_DOLLAR = 20.60 / 1_000_000; // sells only
export const FINRA_TAF_PER_SHARE = 0.000195; // sells only
export const FINRA_TAF_MIN = 0.01;
export const FINRA_TAF_CAP = 9.79;

export interface CommissionInputs {
  side: 'BUY' | 'SELL';
  quantity: number;
  fillPrice: number;
  /** Broker-charged commission per trade. Defaults to 0 - Alpaca's real equity commission. */
  brokerCommissionPerTrade?: number;
}

export interface CommissionResult {
  total: number;
  secFee: number;
  finraTaf: number;
  brokerCommission: number;
}

export function calculateCommission(inputs: CommissionInputs): CommissionResult {
  const brokerCommission = inputs.brokerCommissionPerTrade ?? 0;
  if (inputs.side !== 'SELL' || inputs.quantity <= 0) {
    return { total: Number(brokerCommission.toFixed(2)), secFee: 0, finraTaf: 0, brokerCommission };
  }
  const principal = inputs.quantity * inputs.fillPrice;
  const secFee = Math.ceil(principal * SEC_FEE_RATE_PER_DOLLAR * 100) / 100;
  const rawTaf = Math.ceil(inputs.quantity * FINRA_TAF_PER_SHARE * 100) / 100;
  const finraTaf = Math.max(FINRA_TAF_MIN, Math.min(FINRA_TAF_CAP, rawTaf));
  return {
    total: Number((brokerCommission + secFee + finraTaf).toFixed(2)),
    secFee, finraTaf, brokerCommission,
  };
}
