import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Forensic audit, next target (2026-09-14, per explicit operator instruction): "order
 * acknowledgement ambiguity -> timeout/retry -> reconnect during submission -> client-order-ID
 * idempotency -> late acknowledgement -> duplicate submission prevention."
 *
 * The specific gap this file targets, not covered by any existing test: an order is placed
 * (`placeStockOrder()` -> `ib.placeOrder()`, fire-and-forget over the TCP socket per
 * IbkrSocketSession's own documented design) and the connection drops BEFORE any acknowledgement
 * (openOrder/orderStatus/execDetails) arrives - the exact ambiguous window where Argus does not
 * know whether IB actually received the order. On reconnect, does anything resubmit it? Does the
 * crash-recovery rehydration path (reqOpenOrders/reqExecutions, DEF-30) correctly recover the order
 * if IB confirms it actually reached the broker, without creating a duplicate local record?
 *
 * Same mock harness/pattern as IbkrSocketSession.crashRecovery.test.ts and
 * IbkrSocketSession.reconnect.test.ts (siblings). A second `connect()` cycle is invoked directly
 * (not via the real scheduled backoff timer) since the backoff SCHEDULE itself is already covered
 * by reconnect.test.ts - what this file adds is what happens to an IN-FLIGHT order across that
 * reconnect, which reconnect.test.ts does not touch at all.
 */
vi.mock('../ibkrTcpProbe', () => ({
  findFirstOpenTcpPort: vi.fn(async () => 4002),
}));

type Handlers = Record<string, ((...args: any[]) => void)[]>;

function makeFakeIb() {
  const handlers: Handlers = {};
  const fake = {
    on(event: string, handler: (...args: any[]) => void) {
      (handlers[event] ||= []).push(handler);
      return fake;
    },
    emit(event: string, ...args: any[]) {
      for (const h of handlers[event] || []) h(...args);
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    removeAllListeners: vi.fn(),
    reqIds: vi.fn(),
    reqCurrentTime: vi.fn(),
    reqManagedAccts: vi.fn(),
    reqAccountSummary: vi.fn(),
    reqPositions: vi.fn(),
    reqOpenOrders: vi.fn(),
    reqExecutions: vi.fn(),
    placeOrder: vi.fn(),
    cancelOrder: vi.fn(),
  };
  return fake;
}

let lastFakeIb: ReturnType<typeof makeFakeIb> | null = null;
const allFakeIbs: ReturnType<typeof makeFakeIb>[] = [];

vi.mock('@stoqey/ib', async () => {
  const actual = await vi.importActual<typeof import('@stoqey/ib')>('@stoqey/ib');
  class FakeIBApi {
    constructor() {
      lastFakeIb = makeFakeIb();
      allFakeIbs.push(lastFakeIb);
      return lastFakeIb as any;
    }
  }
  return {
    ...actual,
    IBApi: FakeIBApi,
  };
});

async function connectSuccessfully(session: any) {
  const before = lastFakeIb;
  const connectPromise = session.connect(false);
  for (let i = 0; i < 20 && lastFakeIb === before; i++) {
    await new Promise((r) => setImmediate(r));
  }
  lastFakeIb!.emit('connected');
  lastFakeIb!.emit('nextValidId', 100);
  lastFakeIb!.emit('managedAccounts', 'DU1234567');
  const ok = await connectPromise;
  expect(ok).toBe(true);
}

describe('IbkrSocketSession - order submission racing a mid-session disconnect/reconnect', () => {
  beforeEach(() => {
    lastFakeIb = null;
    allFakeIbs.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('an order placed just before disconnect is never resubmitted after reconnect (no blind retry), and stays locally tracked across the gap', async () => {
    const { IbkrSocketSession } = await import('../IbkrSocketSession');
    const session = new IbkrSocketSession();
    await connectSuccessfully(session as any);
    const firstIb = lastFakeIb!;

    const orderId = session.placeStockOrder({
      symbol: 'AAPL',
      side: 'BUY',
      quantity: 10,
      type: 'MARKET',
      clientOrderId: 'reconnect-order-1',
    });
    expect(firstIb.placeOrder).toHaveBeenCalledTimes(1);

    // The exact ambiguous window: connection drops with NO openOrder/orderStatus/execDetails ever
    // having arrived for this order - Argus genuinely does not know if IB received it.
    firstIb.emit('disconnected');

    // The order must still be locally known (disconnect() does not clear trackedOrders) even
    // though the connection is now down.
    expect(session.getTrackedOrderByClientOrderId('reconnect-order-1')?.id).toBe(orderId);
    expect(session.getTrackedOrderByClientOrderId('reconnect-order-1')?.status).toBe('PENDING');

    // Reconnect cycle (invoked directly - the backoff SCHEDULE itself is covered by
    // IbkrSocketSession.reconnect.test.ts; what matters here is what happens to the in-flight
    // order across it).
    await connectSuccessfully(session as any);
    const secondIb = lastFakeIb!;
    expect(secondIb).not.toBe(firstIb);

    // The invariant this test exists to prove: reconnecting NEVER resubmits a pending order.
    expect(secondIb.placeOrder).not.toHaveBeenCalled();
    expect(firstIb.placeOrder).toHaveBeenCalledTimes(1); // still exactly one call, ever

    // Rehydration is armed again on the new connection (DEF-30's own contract).
    expect(secondIb.reqOpenOrders).toHaveBeenCalledTimes(1);
    expect(secondIb.reqExecutions).toHaveBeenCalledTimes(1);
    expect(session.hasCompletedInitialRehydration()).toBe(false); // not yet - openOrderEnd hasn't fired on this new connection

    // IB confirms (via the new connection's openOrder echo) that the order genuinely reached the
    // broker before the disconnect - this is the "late acknowledgement" case. Since this process
    // already has orderId in trackedOrders from its own placeStockOrder() call, the openOrder
    // handler's existing-row branch must not create a duplicate or lose the original PENDING state
    // to a stale echo.
    secondIb.emit(
      'openOrder',
      orderId,
      { symbol: 'AAPL' },
      { action: 'BUY', totalQuantity: 10, filledQuantity: 0, orderRef: 'reconnect-order-1' },
      { status: 'Submitted' },
    );
    secondIb.emit('openOrderEnd');

    expect(session.hasCompletedInitialRehydration()).toBe(true);
    const tracked = session.getTrackedOrderByClientOrderId('reconnect-order-1');
    expect(tracked?.id).toBe(orderId); // same order, not duplicated under a new id
    expect(tracked?.quantity).toBe(10); // this process's own original placement data preserved, not overwritten by the echo
  });

  it('an order that actually filled at the broker WHILE disconnected is recovered as FILLED on reconnect via execDetails rehydration, not left PENDING or silently lost', async () => {
    const { IbkrSocketSession } = await import('../IbkrSocketSession');
    const session = new IbkrSocketSession();
    await connectSuccessfully(session as any);
    const firstIb = lastFakeIb!;

    const orderId = session.placeStockOrder({
      symbol: 'MSFT',
      side: 'BUY',
      quantity: 5,
      type: 'MARKET',
      clientOrderId: 'reconnect-order-2',
    });
    expect(firstIb.placeOrder).toHaveBeenCalledTimes(1);

    firstIb.emit('disconnected');
    await connectSuccessfully(session as any);
    const secondIb = lastFakeIb!;

    // The order fully filled and dropped out of IB's open-orders set entirely while Argus was
    // disconnected - reqOpenOrders() alone would never see it (DEF-30's own documented gap that
    // reqExecutions() exists to cover). No openOrder event for this order at all; only execDetails.
    secondIb.emit('openOrderEnd'); // no open orders reported for this order
    secondIb.emit(
      'execDetails',
      1,
      { symbol: 'MSFT' },
      { orderId, shares: 5, price: 300.0, side: 'BOT', orderRef: 'reconnect-order-2', execId: 'exec-reconnect-1' },
    );

    expect(secondIb.placeOrder).not.toHaveBeenCalled(); // still never resubmitted
    const tracked = session.getTrackedOrder(orderId);
    expect(tracked?.status).toBe('FILLED');
    expect(tracked?.filledQuantity).toBe(5);
  });
});
