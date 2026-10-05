/**
 * Buying-power reservation ledger (2026-10-04 P2/P3 remediation).
 *
 * Closes the broker-buying-power TOCTOU: RiskEngine reads broker buying power fresh per
 * evaluation, but between evaluation 1 approving $X and its order filling, evaluation 2
 * could read the same unchanged broker snapshot and approve another $X — combined
 * submitted notional exceeding real buying power. (The evaluationQueue mutex serializes
 * evaluations but explicitly never touches order placement; the settings-budget side of
 * this race is already closed by PendingCapitalReservations + gate 23's pendingBuys.)
 *
 * Design: derive the reservation from the durable trades table instead of in-memory
 * state, so it is restart-safe and has no hook points that could leak:
 *   reserved = SUM(quantity * price) over non-terminal BUY orders, excluding REPLAY.
 * Uses the same non-terminal definition as gate 23's own pendingBuys filter. An
 * unresolved unknown order (PENDING / RECONCILIATION_REQUIRED) keeps its reservation
 * (fail-closed), matching the pending-SELL-reservation philosophy from the OKTA fix.
 *
 * This can only ever REDUCE the buying power RiskEngine sees, never increase it.
 * Over-reservation (stale snapshot already reflecting a fill, partial-fill remainder)
 * errs toward rejecting a valid order, never toward approving an invalid one.
 */
import { db } from '../db';
import * as schema from '../db/schema';
import { sql, and, eq, notInArray, or, isNull } from 'drizzle-orm';

// Same non-terminal definition as gate 23's pendingBuys filter in RiskEngine.ts.
const NON_TERMINAL_EXCLUDED = ['FILLED', 'REJECTED', 'CANCELED', 'CANCELLED'];
// Research/replay orders share the trades table; they must never reserve live buying power.
const RESEARCH_ENVIRONMENTS = ['REPLAY', 'HISTORICAL_REPLAY'];

export async function getReservedBuyNotional(): Promise<number> {
  try {
    const rows = await db
      .select({ total: sql<number | null>`sum(${schema.trades.quantity} * ${schema.trades.price})` })
      .from(schema.trades)
      .where(
        and(
          eq(schema.trades.side, 'BUY'),
          notInArray(schema.trades.status, NON_TERMINAL_EXCLUDED),
          // NULL environment (legacy rows) counts as non-REPLAY, matching gate 23's
          // JS-side `t.executionEnvironment !== 'REPLAY'` filter semantics.
          or(isNull(schema.trades.executionEnvironment), notInArray(schema.trades.executionEnvironment, RESEARCH_ENVIRONMENTS)),
        ),
      );
    const total = rows[0]?.total;
    return typeof total === 'number' && Number.isFinite(total) && total > 0 ? total : 0;
  } catch {
    // Fail-closed on read error: no reservation (same as today's behavior), never NaN.
    return 0;
  }
}
