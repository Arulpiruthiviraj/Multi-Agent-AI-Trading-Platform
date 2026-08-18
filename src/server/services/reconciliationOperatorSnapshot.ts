/**
 * Read-only operator snapshot for Mission Control pause/ack/resume.
 * Does not change tradingState, pause, flatten, or invent fills.
 */
export const FILLED_ORDER_MISSING_LOCALLY = 'FILLED_ORDER_MISSING_LOCALLY';

export type ReconMismatchRow = {
  symbol?: string;
  type?: string;
  localQty?: number;
  remoteQty?: number;
  approxDollarImpact?: number;
};

export type UnackedFilledOrphan = {
  brokerOrderId: string;
  symbol: string;
  side?: string;
  quantity?: number;
  averageFillPrice?: number;
};

export function parseReconMismatches(raw: string | null | undefined): ReconMismatchRow[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function latestCycleIsMatch(latest: { matches?: boolean | number | null; mismatches?: string | null } | undefined): boolean {
  if (!latest) return false;
  const matches = latest.matches === true || latest.matches === 1;
  return matches && parseReconMismatches(latest.mismatches).length === 0;
}

/** Broker FILLED orders with no local trades.brokerOrderId and not PRE_EXISTING_RECONCILED. */
export function selectUnackedFilledOrphans(opts: {
  filledBrokerOrders: Array<{
    id?: string;
    symbol?: string;
    side?: string;
    quantity?: number;
    filledQuantity?: number;
    averageFillPrice?: number;
    price?: number;
  }>;
  localBrokerOrderIds: Iterable<string | null | undefined>;
  acknowledgedOrderIds: Iterable<string>;
}): UnackedFilledOrphan[] {
  const local = new Set([...opts.localBrokerOrderIds].filter((id): id is string => !!id));
  const acked = new Set(opts.acknowledgedOrderIds);
  const out: UnackedFilledOrphan[] = [];
  for (const o of opts.filledBrokerOrders) {
    const brokerOrderId = String(o.id || '').trim();
    const symbol = String(o.symbol || '').trim().toUpperCase();
    if (!brokerOrderId || !symbol) continue;
    if (local.has(brokerOrderId) || acked.has(brokerOrderId)) continue;
    out.push({
      brokerOrderId,
      symbol,
      side: o.side,
      quantity: o.filledQuantity ?? o.quantity,
      averageFillPrice: o.averageFillPrice ?? o.price,
    });
  }
  return out;
}
