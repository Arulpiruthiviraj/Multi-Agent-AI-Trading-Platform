/**
 * Closes a real, documented concurrency gap in gate 23 (argus_capital_allocation), first found
 * read-only in docs/audits/archive/ARGUS_CAPITAL_AUDIT_REPORT.md: RiskEngine.evaluationQueue's
 * mutex only serializes evaluateRisk() itself - it releases the instant evaluateRisk() returns,
 * before OrderManagementService's (separately-scheduled, un-mutexed) executeOrder() has actually
 * inserted the real `trades` row the capital gate's own DB query depends on. Two BUY ideas
 * evaluated back-to-back can each see the OTHER's not-yet-persisted notional as unreserved and
 * both pass, jointly exceeding settings.budget.
 *
 * Fix: a lightweight in-memory reservation, made the instant the capital gate passes (still
 * inside evaluateRisk()'s own mutexed critical section) and released the instant OrderManagement
 * has either inserted the real trades row (which the DB-backed pendingBuys query now covers) or
 * abandoned the attempt entirely. This never replaces the DB as the source of truth - it only
 * bridges the real window between risk-approval and that row's insert becoming visible to the
 * next evaluation. Never sizes, never places an order, never touches RiskEngine's gate ladder
 * order - purely additive accounting used by gate 23 alongside its existing DB query.
 */

const reservedNotionalByTraceId = new Map<string, number>();

/** Called the instant gate 23 passes for a BUY, still inside evaluateRisk()'s own mutex. */
export function reservePendingCapital(traceId: string, notional: number): void {
  if (!traceId || !Number.isFinite(notional) || notional <= 0) return;
  reservedNotionalByTraceId.set(traceId, notional);
}

/** Called once OrderManagement has either persisted the real trades row or abandoned the attempt. */
export function releasePendingCapitalReservation(traceId: string): void {
  reservedNotionalByTraceId.delete(traceId);
}

/**
 * Sum of all currently-outstanding reservations, excluding the trace being re-evaluated itself
 * (a retried/duplicate risk evaluation for the same idea must not double-count its own reservation).
 */
export function snapshotReservedNotional(excludeTraceId?: string): number {
  let total = 0;
  for (const [traceId, notional] of reservedNotionalByTraceId) {
    if (traceId === excludeTraceId) continue;
    total += notional;
  }
  return total;
}

/** Test-only: clear all reservations without waiting for their natural release. */
export function resetPendingCapitalReservationsForTests(): void {
  reservedNotionalByTraceId.clear();
}
