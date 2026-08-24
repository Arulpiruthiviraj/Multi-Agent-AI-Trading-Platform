import { describe, it, expect, afterEach } from 'vitest';
import {
  reservePendingCapital,
  releasePendingCapitalReservation,
  snapshotReservedNotional,
  resetPendingCapitalReservationsForTests,
} from './PendingCapitalReservations';
import { snapshotCapital, evaluateAllocationGuard } from './CapitalAllocation';

describe('PendingCapitalReservations', () => {
  afterEach(() => resetPendingCapitalReservationsForTests());

  it('reserves and reports notional for a traceId', () => {
    reservePendingCapital('trace-a', 1500);
    expect(snapshotReservedNotional()).toBe(1500);
  });

  it('sums multiple concurrent reservations', () => {
    reservePendingCapital('trace-a', 1500);
    reservePendingCapital('trace-b', 800);
    expect(snapshotReservedNotional()).toBe(2300);
  });

  it('excludes the caller\'s own traceId so a re-evaluation of the same idea never double-counts itself', () => {
    reservePendingCapital('trace-a', 1500);
    reservePendingCapital('trace-b', 800);
    expect(snapshotReservedNotional('trace-a')).toBe(800);
  });

  it('release removes exactly that reservation, not others', () => {
    reservePendingCapital('trace-a', 1500);
    reservePendingCapital('trace-b', 800);
    releasePendingCapitalReservation('trace-a');
    expect(snapshotReservedNotional()).toBe(800);
  });

  it('releasing an unknown/already-released traceId is a harmless no-op', () => {
    expect(() => releasePendingCapitalReservation('never-reserved')).not.toThrow();
    expect(snapshotReservedNotional()).toBe(0);
  });

  it('ignores non-finite/non-positive notional (never reserves a phantom amount)', () => {
    reservePendingCapital('trace-a', 0);
    reservePendingCapital('trace-b', -5);
    reservePendingCapital('trace-c', NaN);
    expect(snapshotReservedNotional()).toBe(0);
  });

  /**
   * The actual race this module closes (docs/audits/archive/ARGUS_CAPITAL_AUDIT_REPORT.md):
   * two BUY ideas evaluated back-to-back, before OMS has persisted either one's real trades row.
   * Without folding in the in-memory reservation (exactly as RiskEngine.ts now does around its
   * capitalSnap computation), idea B's DB-backed pendingBuys query cannot see idea A's still-in-
   * flight notional and would wrongly pass even though the two combined exceed the budget.
   */
  it('reproduces and closes the real concurrent-BUY-approval race against a $2000 budget', () => {
    const allocated = 2000;
    const positions: Array<{ quantity: number; averagePrice: number }> = []; // no existing holdings
    const dbPendingBuys: Array<{ quantity: number; price: number; side: string }> = []; // idea A's trades row not inserted yet

    // Idea A: $1500 BUY approved and reserved (still inside evaluateRisk()'s mutex).
    const snapA = snapshotCapital({ allocated, positions, pendingBuys: dbPendingBuys });
    const guardA = evaluateAllocationGuard(snapA, 'BUY', 1500);
    expect(guardA.passed).toBe(true);
    reservePendingCapital('trace-a', 1500);

    // Idea B: a second $1500 BUY evaluated before A's real trades row exists. The DB-backed
    // pendingBuys is still empty (A's insert hasn't happened), so without the fix this would
    // wrongly pass too (1500 <= 2000). With the fix, RiskEngine.ts folds in the reservation:
    const reservedForB = snapshotReservedNotional('trace-b');
    const snapBRaw = snapshotCapital({ allocated, positions, pendingBuys: dbPendingBuys });
    const snapBWithInFlight = reservedForB > 0
      ? { ...snapBRaw, reservedPendingBuys: snapBRaw.reservedPendingBuys + reservedForB, used: snapBRaw.used + reservedForB, remaining: Math.max(0, snapBRaw.remaining - reservedForB) }
      : snapBRaw;
    const guardB = evaluateAllocationGuard(snapBWithInFlight, 'BUY', 1500);

    expect(guardB.passed).toBe(false); // $1500 + $1500 = $3000 > $2000 budget - correctly rejected
    expect(guardB.reason).toMatch(/Remaining Argus allocation/);

    // Once OMS inserts A's real trades row and releases the reservation, the DB query itself
    // would then see it (not exercised here - CapitalAllocation.ts's DB-query side is unchanged).
    releasePendingCapitalReservation('trace-a');
    expect(snapshotReservedNotional()).toBe(0);
  });
});
