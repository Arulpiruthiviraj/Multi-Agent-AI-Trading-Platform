/**
 * riskOracle.ts - INDEPENDENT calculation of the maximum permissible BUY quantity from raw scenario state.
 *
 * It re-derives the caps from first principles (capital basis x percentage, whole shares, remaining allocation) and imports NOTHING from
 * PositionSizing / RiskEngine / CapitalAllocation. Policy numbers are passed in by the caller (loaded from config/tradingSafety.json
 * and settings), so the oracle encodes the arithmetic, not the thresholds. Pure; labeled CERTIFICATION_FIXTURE_ONLY when used on
 * synthetic sessions.
 *
 * Comparison contract (safety direction first): an approved quantity ABOVE the oracle maximum is a hard violation (over-exposure).
 * An approved quantity BELOW the oracle maximum is reported separately as UNDER_SIZED (informational: conservative, but it means
 * Argus applied a cap the oracle does not know about, which must be explainable).
 */
export interface RiskOracleInput {
  side: 'BUY';
  symbol: string;
  price: number;
  /** research capital basis in USD (budget + realized net + unrealized) - NOT broker equity */
  capitalBasis: number;
  maxTradeSizeUsd: number;
  maxPortfolioRiskPct: number;
  stopLossAssumptionPct: number;
  buyingPower: number;
  maxSingleSymbolConcentrationPct: number;
  maxSectorConcentrationPct: number;
  maxOpenPositions: number;
  /** Argus allocation (settings.budget) minus positions at cost minus pending BUY notional, floored at 0 */
  remainingAllocationUsd: number;
  holdings: Array<{ symbol: string; quantity: number; markPrice: number; sector: string | null }>;
  proposalSector: string | null;
}

export interface RiskOracleResult {
  maxQuantity: number;
  binding: string;
  caps: Record<string, number>;
}

const wholeShares = (usd: number, price: number) => (price > 0 && usd > 0 ? Math.floor(usd / price + 1e-9) : 0);

export function maxPermissibleBuyQuantity(i: RiskOracleInput): RiskOracleResult {
  const existing = i.holdings.find((h) => h.symbol === i.symbol);
  const existingValue = existing ? existing.quantity * i.price : 0;
  const sectorValue = i.proposalSector
    ? i.holdings.filter((h) => h.sector === i.proposalSector).reduce((s, h) => s + h.quantity * (h.symbol === i.symbol ? i.price : h.markPrice), 0)
    : 0;
  const caps: Record<string, number> = {
    notional: wholeShares(i.maxTradeSizeUsd, i.price),
    risk: wholeShares(i.capitalBasis * i.maxPortfolioRiskPct, i.price * i.stopLossAssumptionPct),
    buyingPower: wholeShares(i.buyingPower, i.price),
    symbolConcentration: wholeShares(i.capitalBasis * i.maxSingleSymbolConcentrationPct - existingValue, i.price),
    allocation: wholeShares(i.remainingAllocationUsd, i.price),
    openPositions: !existing && i.holdings.filter((h) => h.quantity !== 0).length >= i.maxOpenPositions ? 0 : Number.POSITIVE_INFINITY,
  };
  if (i.proposalSector) caps.sectorConcentration = wholeShares(i.capitalBasis * i.maxSectorConcentrationPct - sectorValue, i.price);
  let binding = 'notional'; let min = Number.POSITIVE_INFINITY;
  for (const [k, v] of Object.entries(caps)) if (v < min) { min = v; binding = k; }
  return { maxQuantity: Number.isFinite(min) ? Math.max(0, min) : 0, binding, caps };
}

export interface BuyApproval { traceId: string; symbol: string; approvedQuantity: number; input: RiskOracleInput }
export interface RiskMismatch { code: 'OVER_EXPOSURE' | 'UNDER_SIZED' | 'APPROVED_WITH_ZERO_ORACLE_ROOM'; detail: string }

export function compareApprovalsToOracle(approvals: BuyApproval[]): RiskMismatch[] {
  const out: RiskMismatch[] = [];
  for (const a of approvals) {
    const o = maxPermissibleBuyQuantity(a.input);
    if (a.approvedQuantity > o.maxQuantity) {
      out.push({ code: o.maxQuantity === 0 ? 'APPROVED_WITH_ZERO_ORACLE_ROOM' : 'OVER_EXPOSURE', detail: `${a.traceId} ${a.symbol}: approved ${a.approvedQuantity} > oracle max ${o.maxQuantity} (binding ${o.binding}; caps ${JSON.stringify(o.caps)})` });
    } else if (a.approvedQuantity < o.maxQuantity) {
      out.push({ code: 'UNDER_SIZED', detail: `${a.traceId} ${a.symbol}: approved ${a.approvedQuantity} < oracle max ${o.maxQuantity} (binding ${o.binding}) - conservative; an unmodelled cap applied` });
    }
  }
  return out;
}
