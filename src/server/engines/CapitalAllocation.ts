/**
 * Argus trading allocation vs broker cash are different numbers.
 * Broker buying power MUST NOT authorize a notional above settings.budget.
 * Pure math — RiskEngine is the only live caller; backtests do not use this
 * (they simulate a dedicated paper account, not a slice of a larger live account).
 */
export interface CapitalSnapshot {
  allocated: number;
  usedPositions: number;
  reservedPendingBuys: number;
  used: number;
  remaining: number;
  /**
   * 2026-10-01 defect verification pass (finding 4.3): true when at least one held position
   * (quantity > 0) had no resolvable finite positive price (neither averagePrice nor avgPrice).
   * The old `Number(p.averagePrice ?? p.avgPrice ?? 0) || 0` pattern silently treated that
   * position's dollar value as $0 in usedPositions, understating `used` and overstating
   * `remaining` - a real capital-accounting fail-open (RiskEngine gate 23 could approve a BUY it
   * should have blocked because an existing position's value vanished from the calculation).
   * Same class of gap as F26's Position.marketValue: number | null + valuationStatus pattern
   * (CoinbaseBroker.ts / PortfolioRebalance.ts) - a missing price must be surfaced, not coerced
   * to zero. evaluateAllocationGuard() below fails BUY (never SELL) closed when this is true.
   */
  degraded: boolean;
}

export interface CapitalGuardResult {
  passed: boolean;
  requestedNotional: number;
  remaining: number;
  allocated: number;
  used: number;
  reason: string;
}

export function snapshotCapital(input: {
  allocated: number;
  /**
   * 2026-10-01 defect verification pass (finding 4.3): two real, differently-shaped callers feed
   * this function. RiskEngine.ts's gate 23 (the safety-critical one) passes `broker.portfolio()`'s
   * live Position[] straight through - BrokerAdapter.ts's real Position type uses `entryPrice:
   * number | null` (the reviewed F26 convention), which has NO `averagePrice`/`avgPrice` field at
   * all. CampaignTracker.ts/RiskEngine.ts's campaign-velocity path instead passes rows from the DB
   * `portfolio` table (schema.ts), which genuinely does have an `averagePrice` column. Checking
   * entryPrice too (not just averagePrice/avgPrice) is a real correctness fix, not a style choice -
   * without it, gate 23's live caller never resolved a price for any real held position.
   */
  positions: Array<{ quantity: number; averagePrice?: number | null; avgPrice?: number | null; entryPrice?: number | null; marketValue?: number | null }>;
  pendingBuys: Array<{ quantity: number; price: number; side?: string; status?: string }>;
}): CapitalSnapshot {
  const allocated = Number.isFinite(input.allocated) && input.allocated > 0 ? input.allocated : 0;
  let usedPositions = 0;
  let degraded = false;
  for (const p of input.positions) {
    const qty = Number(p.quantity) || 0;
    if (qty <= 0) continue;
    const rawPx = p.averagePrice ?? p.avgPrice ?? p.entryPrice;
    const px = Number(rawPx);
    if (!Number.isFinite(px) || px <= 0) {
      degraded = true; // unresolved price - do NOT silently treat this position's value as $0
      continue;
    }
    usedPositions += qty * px;
  }
  let reservedPendingBuys = 0;
  for (const t of input.pendingBuys) {
    if ((t.side || 'BUY') !== 'BUY') continue;
    const qty = Number(t.quantity) || 0;
    const px = Number(t.price) || 0;
    if (qty > 0 && px > 0) reservedPendingBuys += qty * px;
  }
  const used = usedPositions + reservedPendingBuys;
  return {
    allocated,
    usedPositions,
    reservedPendingBuys,
    used,
    remaining: Math.max(0, allocated - used),
    degraded,
  };
}

/** SELL frees capital and never consumes allocation. BUY must fit in remaining. */
export function evaluateAllocationGuard(
  snapshot: CapitalSnapshot,
  side: string,
  requestedNotional: number,
): CapitalGuardResult {
  if (side !== 'BUY') {
    return {
      passed: true,
      requestedNotional,
      remaining: snapshot.remaining,
      allocated: snapshot.allocated,
      used: snapshot.used,
      reason: 'SELL/exit does not consume Argus allocation.',
    };
  }
  const requested = Number(requestedNotional) || 0;
  if (snapshot.degraded) {
    return {
      passed: false,
      requestedNotional: requested,
      remaining: snapshot.remaining,
      allocated: snapshot.allocated,
      used: snapshot.used,
      reason: 'CAPITAL_SNAPSHOT_DEGRADED: at least one existing held position has no resolvable price, so remaining Argus allocation cannot be safely computed. No new BUY authorized until every held position reports a valid price.',
    };
  }
  if (!(Number.isFinite(snapshot.allocated) && snapshot.allocated > 0)) {
    return {
      passed: false,
      requestedNotional: requested,
      remaining: snapshot.remaining,
      allocated: snapshot.allocated,
      used: snapshot.used,
      reason: 'INVALID_ARGUS_BUDGET: allocated budget is missing or not positive. No phantom capital is assumed.',
    };
  }
  if (requested <= 0) {
    return {
      passed: false,
      requestedNotional: requested,
      remaining: snapshot.remaining,
      allocated: snapshot.allocated,
      used: snapshot.used,
      reason: 'Requested BUY notional is missing or zero.',
    };
  }
  const passed = requested <= snapshot.remaining + 1e-9;
  return {
    passed,
    requestedNotional: requested,
    remaining: snapshot.remaining,
    allocated: snapshot.allocated,
    used: snapshot.used,
    reason: passed
      ? `BUY $${requested.toFixed(2)} fits remaining Argus allocation $${snapshot.remaining.toFixed(2)} of $${snapshot.allocated.toFixed(2)}.`
      : `Remaining Argus allocation = $${snapshot.remaining.toFixed(2)}; requested capital = $${requested.toFixed(2)} (allocated $${snapshot.allocated.toFixed(2)}, already used $${snapshot.used.toFixed(2)}). Broker buying power is irrelevant — Argus may not spend the rest of the account.`,
  };
}
