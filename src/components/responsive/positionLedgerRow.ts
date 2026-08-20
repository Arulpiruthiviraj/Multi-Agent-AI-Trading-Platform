import type { PositionRow } from './PositionsDataView';

/** Finite float or null — never NaN, never coerced empty-string → 0. */
export function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Map a broker / API position into ledger columns.
 * Alpaca (and InternalPaper) expose entryPrice + currentPrice + unrealizedPnl — not totalCost.
 * App.tsx used to do `marketValue - p.totalCost`, which is `x - undefined` → NaN → `$NaN (0.00%)`.
 */
export function toPositionLedgerRow(
  p: Record<string, unknown> | null | undefined,
  liveTick?: number | null,
): PositionRow {
  const raw = p && typeof p === 'object' ? p : {};
  const symbol = String(raw.symbol ?? '').trim() || '—';
  const sector = typeof raw.sector === 'string' && raw.sector.trim() ? raw.sector : undefined;

  const quantity =
    finiteNumber(raw.quantity) ?? finiteNumber(raw.qty) ?? finiteNumber(raw.shares) ?? finiteNumber(raw.qtyAvailable);
  const entryPrice =
    finiteNumber(raw.entryPrice) ??
    finiteNumber(raw.avgEntryPrice) ??
    finiteNumber(raw.avg_entry_price) ??
    finiteNumber(raw.averagePrice) ??
    finiteNumber(raw.avgCost);
  const livePrice =
    finiteNumber(liveTick) ??
    finiteNumber(raw.currentPrice) ??
    finiteNumber(raw.livePrice) ??
    finiteNumber(raw.current_price);
  const costBasis =
    finiteNumber(raw.totalCost) ??
    finiteNumber(raw.costBasis) ??
    finiteNumber(raw.cost_basis) ??
    (quantity != null && entryPrice != null ? quantity * entryPrice : null);
  const marketValue =
    finiteNumber(raw.marketValue) ??
    finiteNumber(raw.market_value) ??
    (quantity != null && livePrice != null ? quantity * livePrice : null);

  const brokerPnl =
    finiteNumber(raw.unrealizedPnl) ??
    finiteNumber(raw.unrealized_pl) ??
    finiteNumber(raw.openPnl);
  const computedPnl =
    marketValue != null && costBasis != null
      ? marketValue - costBasis
      : quantity != null && livePrice != null && entryPrice != null
        ? (livePrice - entryPrice) * quantity
        : null;
  const unrealizedPnl = brokerPnl ?? computedPnl;

  let unrealizedPnlPercent: number | null = null;
  if (unrealizedPnl != null && costBasis != null && Math.abs(costBasis) > 0) {
    unrealizedPnlPercent = (unrealizedPnl / Math.abs(costBasis)) * 100;
  } else {
    const brokerPct =
      finiteNumber(raw.unrealizedPnlPercent) ?? finiteNumber(raw.unrealized_plpc);
    if (brokerPct != null) {
      // Alpaca/InternalPaper store a fraction (0.05 = 5%); Questrade stores percentage points.
      unrealizedPnlPercent = Math.abs(brokerPct) <= 1 ? brokerPct * 100 : brokerPct;
    }
  }

  const stopLossPrice = finiteNumber(raw.stopLossPrice);
  const takeProfitPrice = finiteNumber(raw.takeProfitPrice);

  return {
    symbol,
    sector,
    quantity: quantity ?? Number.NaN,
    entryPrice: entryPrice ?? Number.NaN,
    livePrice,
    marketValue,
    unrealizedPnl,
    unrealizedPnlPercent,
    isPositive: unrealizedPnl == null ? true : unrealizedPnl >= 0,
    stopLossPrice,
    takeProfitPrice,
  };
}
