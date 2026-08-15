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
  positions: Array<{ quantity: number; averagePrice?: number; avgPrice?: number; marketValue?: number }>;
  pendingBuys: Array<{ quantity: number; price: number; side?: string; status?: string }>;
}): CapitalSnapshot {
  const allocated = Math.max(0, input.allocated || 0);
  let usedPositions = 0;
  for (const p of input.positions) {
    const qty = Number(p.quantity) || 0;
    if (qty <= 0) continue;
    const px = Number(p.averagePrice ?? p.avgPrice ?? 0) || 0;
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
