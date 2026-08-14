/**
 * ==========================================================
 * Module: quant/analysis/AccountSizeReport
 *
 * Purpose:
 * E7 (BACKTEST_QUANT_HARDENING_ANALYSIS.md), Phase 15 of the original audit request - honest
 * capital-utilization reporting across candidate account sizes. No broker adapter in this
 * codebase supports fractional/notional order sizing (AlpacaBroker places whole-share `qty`
 * orders only) - this module reports "TRADE NOT POSSIBLE - WHOLE SHARE CONSTRAINT" for an
 * account too small to afford one real share, rather than silently assuming fractional shares.
 * ==========================================================
 */
import { STOP_LOSS_ASSUMPTION_PCT } from '../../engines/PositionSizing';

export const DEFAULT_ACCOUNT_SIZE_SCENARIOS = [100, 500, 1000, 5000, 10000, 100000];

export interface AccountSizeScenario {
  capital: number;
  affordableShares: number;
  tradePossible: boolean;
  capitalUtilizationPct: number | null; // null when tradePossible=false
  estimatedRiskPerTradeDollar: number | null;
  estimatedRiskPerTradePct: number | null;
  reason: string | null; // set only when tradePossible=false
}

/** `price` is a real representative price (e.g. the first bar's close of the backtest window, or
 *  the average entry price of the strategy's real closed trades) - never fabricated. */
export function buildAccountSizeReport(price: number, candidateCapitals: number[] = DEFAULT_ACCOUNT_SIZE_SCENARIOS): AccountSizeScenario[] {
  return candidateCapitals.map((capital) => {
    const affordableShares = Math.floor(capital / price);
    if (affordableShares < 1) {
      return {
        capital, affordableShares: 0, tradePossible: false,
        capitalUtilizationPct: null, estimatedRiskPerTradeDollar: null, estimatedRiskPerTradePct: null,
        reason: `TRADE NOT POSSIBLE - WHOLE SHARE CONSTRAINT: 1 share at $${price.toFixed(2)} costs more than this $${capital.toLocaleString()} account, and no broker in this codebase supports fractional shares.`,
      };
    }
    const notional = affordableShares * price;
    const riskDollar = notional * STOP_LOSS_ASSUMPTION_PCT;
    return {
      capital, affordableShares, tradePossible: true,
      capitalUtilizationPct: Number(((notional / capital) * 100).toFixed(1)),
      estimatedRiskPerTradeDollar: Number(riskDollar.toFixed(2)),
      estimatedRiskPerTradePct: Number(((riskDollar / capital) * 100).toFixed(2)),
      reason: null,
    };
  });
}
