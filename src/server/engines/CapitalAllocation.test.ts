import { describe, it, expect } from 'vitest';
import { snapshotCapital, evaluateAllocationGuard } from './CapitalAllocation';

describe('Argus capital allocation (broker cash ≠ trading authority)', () => {
  it('rejects $101 against a $100 allocation even if the broker has $2000', () => {
    const snap = snapshotCapital({ allocated: 100, positions: [], pendingBuys: [] });
    expect(snap.remaining).toBe(100);
    const result = evaluateAllocationGuard(snap, 'BUY', 101);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/Remaining Argus allocation = \$100/);
  });

  it('approves a $60 BUY against $100 unused allocation', () => {
    const snap = snapshotCapital({ allocated: 100, positions: [], pendingBuys: [] });
    expect(evaluateAllocationGuard(snap, 'BUY', 60).passed).toBe(true);
  });

  it('rejects a second $50 BUY after $60 is committed (only $40 remains)', () => {
    const afterFill = snapshotCapital({
      allocated: 100,
      positions: [{ quantity: 1, averagePrice: 60 }],
      pendingBuys: [],
    });
    expect(afterFill.used).toBe(60);
    expect(afterFill.remaining).toBe(40);
    const result = evaluateAllocationGuard(afterFill, 'BUY', 50);
    expect(result.passed).toBe(false);
  });

  it('counts reserved PENDING BUY notional as used before the fill lands', () => {
    const snap = snapshotCapital({
      allocated: 100,
      positions: [],
      pendingBuys: [{ quantity: 2, price: 30, side: 'BUY', status: 'PENDING' }],
    });
    expect(snap.reservedPendingBuys).toBe(60);
    expect(evaluateAllocationGuard(snap, 'BUY', 50).passed).toBe(false);
  });

  it('does not consume allocation on SELL', () => {
    const snap = snapshotCapital({ allocated: 100, positions: [{ quantity: 1, averagePrice: 60 }], pendingBuys: [] });
    expect(evaluateAllocationGuard(snap, 'SELL', 60).passed).toBe(true);
  });

  it('fail-closes BUY when allocated budget is missing or not positive', () => {
    const zero = snapshotCapital({ allocated: 0, positions: [], pendingBuys: [] });
    const r0 = evaluateAllocationGuard(zero, 'BUY', 10);
    expect(r0.passed).toBe(false);
    expect(r0.reason).toMatch(/INVALID_ARGUS_BUDGET/);

    const nan = snapshotCapital({ allocated: Number.NaN, positions: [], pendingBuys: [] });
    const rNan = evaluateAllocationGuard(nan, 'BUY', 10);
    expect(rNan.passed).toBe(false);
    expect(rNan.reason).toMatch(/INVALID_ARGUS_BUDGET/);
  });

  describe('2026-10-01 defect verification pass (finding 4.3): a held position with no resolvable price must not silently count as $0', () => {
    it('flags the snapshot degraded when a held position has a NaN averagePrice, instead of treating its value as $0', () => {
      const snap = snapshotCapital({
        allocated: 100,
        positions: [{ quantity: 10, averagePrice: Number.NaN }],
        pendingBuys: [],
      });
      expect(snap.degraded).toBe(true);
      expect(snap.usedPositions).toBe(0); // old behavior would have also been 0 - degraded is the real signal
      expect(snap.remaining).toBe(100); // old behavior silently reported the full $100 as free - still true here, which is exactly why the guard below must fail-close instead
    });

    it('flags degraded when averagePrice and avgPrice are both missing (undefined)', () => {
      const snap = snapshotCapital({ allocated: 100, positions: [{ quantity: 5 }], pendingBuys: [] });
      expect(snap.degraded).toBe(true);
    });

    it('does NOT flag degraded for a position with a real, valid price', () => {
      const snap = snapshotCapital({ allocated: 100, positions: [{ quantity: 1, averagePrice: 60 }], pendingBuys: [] });
      expect(snap.degraded).toBe(false);
    });

    it('the real exploit: a NaN-priced position previously let a BUY through that should have been blocked - evaluateAllocationGuard now fails it closed', () => {
      // Broker reports a real $9000 position (100 shares @ $90) but with a corrupted/missing price field.
      const snap = snapshotCapital({
        allocated: 100,
        positions: [{ quantity: 100, averagePrice: Number.NaN }],
        pendingBuys: [],
      });
      // Old behavior: usedPositions=0, remaining=$100 (the full allocation, as if the $9000 position didn't exist),
      // so a new $90 BUY would have PASSED here - a real capital-accounting fail-open.
      const result = evaluateAllocationGuard(snap, 'BUY', 90);
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/CAPITAL_SNAPSHOT_DEGRADED/);
    });

    it('SELL/exit is never blocked by a degraded snapshot - capital preservation must not be held hostage by a bad price field', () => {
      const snap = snapshotCapital({
        allocated: 100,
        positions: [{ quantity: 100, averagePrice: Number.NaN }],
        pendingBuys: [],
      });
      expect(snap.degraded).toBe(true);
      const result = evaluateAllocationGuard(snap, 'SELL', 90);
      expect(result.passed).toBe(true);
    });

    it('a zero or negative averagePrice is also treated as unresolved, not a real $0 cost basis', () => {
      const snap = snapshotCapital({ allocated: 100, positions: [{ quantity: 10, averagePrice: 0 }], pendingBuys: [] });
      expect(snap.degraded).toBe(true);
      const snapNeg = snapshotCapital({ allocated: 100, positions: [{ quantity: 10, averagePrice: -5 }], pendingBuys: [] });
      expect(snapNeg.degraded).toBe(true);
    });
  });
});
