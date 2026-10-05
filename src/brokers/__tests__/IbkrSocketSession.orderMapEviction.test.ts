import { describe, it, expect } from 'vitest';
import { IbkrSocketSession } from '../IbkrSocketSession';

/**
 * Real defect found and fixed (2026-10-05 memory investigation). IbkrSocketSession's
 * trackedOrders (and its coherent clientOrderIdIndex / execIdToOrderId / commissionByExecId
 * maps) grew by one entry per order ever seen, for process lifetime - terminal
 * FILLED/CANCELED/REJECTED orders were never removed. This proves the fix evicts
 * oldest-terminal-first when over the configured cap, never touches non-terminal orders,
 * and evicts the index/commission entries coherently with their order.
 */
describe('IbkrSocketSession order-map eviction (real defect: terminal orders never evicted)', () => {
  function sessionWithCap(cap: number): any {
    return new IbkrSocketSession({ trackedOrderMapMaxEntries: cap } as any) as any;
  }

  function trackedOrder(id: number, status: 'PENDING' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED', updatedAt: Date): any {
    return {
      id,
      symbol: 'AAPL',
      side: 'BUY',
      type: 'MARKET',
      quantity: 10,
      filledQuantity: status === 'FILLED' ? 10 : 0,
      averageFillPrice: 100,
      status,
      createdAt: updatedAt,
      updatedAt,
      clientOrderId: `c-${id}`,
      execDetailsCumulative: 0,
      seenExecutionIds: new Set<string>(),
    };
  }

  it('evicts oldest terminal orders first when over cap, never non-terminal ones', () => {
    const session = sessionWithCap(3);
    const t0 = new Date('2026-01-01T00:00:00Z');
    session.trackedOrders.set(1, trackedOrder(1, 'PENDING', t0));
    session.trackedOrders.set(2, trackedOrder(2, 'PARTIALLY_FILLED', t0));
    session.trackedOrders.set(3, trackedOrder(3, 'FILLED', new Date('2026-01-01T00:00:00Z')));
    session.trackedOrders.set(4, trackedOrder(4, 'CANCELED', new Date('2026-01-02T00:00:00Z')));
    session.trackedOrders.set(5, trackedOrder(5, 'REJECTED', new Date('2026-01-03T00:00:00Z')));
    session.clientOrderIdIndex.set('c-3', 3);
    session.clientOrderIdIndex.set('c-4', 4);
    session.clientOrderIdIndex.set('c-5', 5);
    session.execIdToOrderId.set('e-3', 3);
    session.commissionByExecId.set('e-3', 1.5);
    session.evictTerminalOrdersIfOverCap();
    // Over by 2 -> the two oldest terminal orders (3, 4) go; non-terminal (1, 2) and the
    // newest terminal (5) stay.
    expect(session.trackedOrders.has(1)).toBe(true);
    expect(session.trackedOrders.has(2)).toBe(true);
    expect(session.trackedOrders.has(3)).toBe(false);
    expect(session.trackedOrders.has(4)).toBe(false);
    expect(session.trackedOrders.has(5)).toBe(true);
    expect(session.trackedOrders.size).toBe(3);
    // Index and commission entries evicted coherently with their order.
    expect(session.clientOrderIdIndex.has('c-3')).toBe(false);
    expect(session.clientOrderIdIndex.has('c-4')).toBe(false);
    expect(session.clientOrderIdIndex.has('c-5')).toBe(true);
    expect(session.execIdToOrderId.has('e-3')).toBe(false);
    expect(session.commissionByExecId.has('e-3')).toBe(false);
  });

  it('does nothing when at or under the cap', () => {
    const session = sessionWithCap(10);
    const t0 = new Date('2026-01-01T00:00:00Z');
    session.trackedOrders.set(1, trackedOrder(1, 'FILLED', t0));
    session.trackedOrders.set(2, trackedOrder(2, 'CANCELED', t0));
    session.evictTerminalOrdersIfOverCap();
    expect(session.trackedOrders.size).toBe(2);
  });

  it('never evicts non-terminal orders even when far over cap with no terminal orders to evict', () => {
    const session = sessionWithCap(1);
    const t0 = new Date('2026-01-01T00:00:00Z');
    session.trackedOrders.set(1, trackedOrder(1, 'PENDING', t0));
    session.trackedOrders.set(2, trackedOrder(2, 'PARTIALLY_FILLED', t0));
    session.evictTerminalOrdersIfOverCap();
    // Nothing evictable: both orders are live and must survive for crash-recovery lookups.
    expect(session.trackedOrders.size).toBe(2);
  });
});
