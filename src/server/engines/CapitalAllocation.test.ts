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
});
