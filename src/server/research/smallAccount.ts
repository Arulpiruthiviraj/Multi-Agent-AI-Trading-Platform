/**
 * Small-account research friction. Does not imply $100 percentage returns are executable live.
 */
import { researchSafety } from '../config/researchSafety';

export interface SmallAccountResearch {
  capital: number;
  mode: 'SMALL_ACCOUNT_RESEARCH_MODE';
  wholeShares: number;
  notional: number;
  leftoverCash: number;
  executable: boolean;
  reason: string | null;
}

export function sizeSmallAccount(capital: number, price: number, minQty = 1, allowFractional = false): SmallAccountResearch {
  if (!researchSafety.smallAccountCapitals.includes(capital)) {
    return {
      capital,
      mode: 'SMALL_ACCOUNT_RESEARCH_MODE',
      wholeShares: 0,
      notional: 0,
      leftoverCash: capital,
      executable: false,
      reason: 'CAPITAL_NOT_IN_SMALL_ACCOUNT_SET',
    };
  }
  if (price <= 0) {
    return { capital, mode: 'SMALL_ACCOUNT_RESEARCH_MODE', wholeShares: 0, notional: 0, leftoverCash: capital, executable: false, reason: 'INVALID_PRICE' };
  }
  const wholeShares = allowFractional ? capital / price : Math.floor(capital / price);
  const shares = allowFractional ? wholeShares : Math.floor(wholeShares);
  const executable = shares >= minQty;
  return {
    capital,
    mode: 'SMALL_ACCOUNT_RESEARCH_MODE',
    wholeShares: shares,
    notional: shares * price,
    leftoverCash: capital - shares * price,
    executable,
    reason: executable ? null : 'INSUFFICIENT_CASH_FOR_MIN_LOT',
  };
}
