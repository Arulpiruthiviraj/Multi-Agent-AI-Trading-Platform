import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Forensic audit pass 3, item 3 (duplicate-fill accounting): proves a real double-counting defect
 * in IbkrSocketSession's fill accounting, found while verifying the user's stated invariant ("same
 * broker execution increases authoritative fill quantity exactly once regardless of replay").
 *
 * IB's orderStatus event reports `filled` as a CUMULATIVE running total (IB API semantics) - the
 * orderStatus handler correctly treats it that way (`row.filledQuantity = filledQty`, an overwrite).
 * IB's execDetails event reports `shares` as the quantity of that ONE execution (a per-fill
 * increment, not cumulative) - the execDetails handler correctly treats it that way
 * (`row.filledQuantity = prevFilled + shares`, an accumulation). Both handlers mutate the SAME
 * `row.filledQuantity` field on the same TrackedOrder object. IB does not guarantee execDetails
 * fires before orderStatus for a given fill (they are separate, independently-ordered event
 * streams) - if orderStatus (cumulative) lands first, a subsequent execDetails for that same fill
 * adds its shares AGAIN on top of the already-cumulative value, double-counting filledQuantity for
 * an ordinary, non-crash-recovery, single-process live order.
 *
 * Same mock harness/pattern as IbkrSocketSession.crashRecovery.test.ts (sibling file).
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

vi.mock('@stoqey/ib', async () => {
  const actual = await vi.importActual<typeof import('@stoqey/ib')>('@stoqey/ib');
  class FakeIBApi {
    constructor() {
      lastFakeIb = makeFakeIb();
      return lastFakeIb as any;
    }
  }
  return {
    ...actual,
    IBApi: FakeIBApi,
  };
});

async function connectSuccessfully(session: any) {
  lastFakeIb = null;
  const connectPromise = session.connect(false);
  for (let i = 0; i < 20 && !lastFakeIb; i++) {
    await new Promise((r) => setImmediate(r));
  }
  lastFakeIb!.emit('connected');
  lastFakeIb!.emit('nextValidId', 100);
  lastFakeIb!.emit('managedAccounts', 'DU1234567');
  const ok = await connectPromise;
  expect(ok).toBe(true);
}

describe('IbkrSocketSession fill accounting - orderStatus/execDetails double-count race', () => {
  beforeEach(() => {
    lastFakeIb = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('DEFECT reproduction: orderStatus (cumulative) landing before execDetails (incremental) for the same fill double-counts filledQuantity', async () => {
    const { IbkrSocketSession } = await import('../IbkrSocketSession');
    const session = new IbkrSocketSession();
    await connectSuccessfully(session as any);

    const orderId = session.placeStockOrder({
      symbol: 'AAPL',
      side: 'BUY',
      quantity: 10,
      type: 'MARKET',
      clientOrderId: 'race-order-1',
    });

    // Real IB event ordering for one 10-share fill on a 10-share order: orderStatus reports the
    // POST-FILL CUMULATIVE total (10, IB's own semantics), execDetails independently reports the
    // SAME execution's own share count (10, IB's own semantics for that stream). These describe
    // the exact same real-world fill, not two different fills.
    lastFakeIb!.emit('orderStatus', orderId, 'Filled', 10, 0, 150.0);
    lastFakeIb!.emit('execDetails', 1, { symbol: 'AAPL' }, { orderId, shares: 10, price: 150.0, side: 'BOT' });

    const tracked = session.getTrackedOrder(orderId);
    // Correct value is 10 (one real 10-share fill). The defect produces 20 (10 cumulative +
    // 10 incremental double-counted) because execDetails's accumulation runs on top of
    // orderStatus's already-cumulative value with no shared bookkeeping between the two handlers.
    expect(tracked?.filledQuantity).toBe(10);
  });

  it('same scenario, reversed real-world event order (execDetails before orderStatus) does NOT double-count - proving the bug is ordering-dependent, not universal', async () => {
    const { IbkrSocketSession } = await import('../IbkrSocketSession');
    const session = new IbkrSocketSession();
    await connectSuccessfully(session as any);

    const orderId = session.placeStockOrder({
      symbol: 'MSFT',
      side: 'BUY',
      quantity: 10,
      type: 'MARKET',
      clientOrderId: 'race-order-2',
    });

    lastFakeIb!.emit('execDetails', 1, { symbol: 'MSFT' }, { orderId, shares: 10, price: 300.0, side: 'BOT' });
    lastFakeIb!.emit('orderStatus', orderId, 'Filled', 10, 0, 300.0);

    const tracked = session.getTrackedOrder(orderId);
    expect(tracked?.filledQuantity).toBe(10); // orderStatus's cumulative overwrite lands last and is correct here
  });

  it('DEFECT reproduction, multi-fill order: two partial fills each reported via both event types double-counts to 2x the real quantity', async () => {
    const { IbkrSocketSession } = await import('../IbkrSocketSession');
    const session = new IbkrSocketSession();
    await connectSuccessfully(session as any);

    const orderId = session.placeStockOrder({
      symbol: 'TSLA',
      side: 'BUY',
      quantity: 20,
      type: 'MARKET',
      clientOrderId: 'race-order-3',
    });

    // Real fill 1: 10 shares. orderStatus (cumulative=10) lands before execDetails (shares=10).
    lastFakeIb!.emit('orderStatus', orderId, 'PartiallyFilled', 10, 10, 200.0);
    lastFakeIb!.emit('execDetails', 1, { symbol: 'TSLA' }, { orderId, shares: 10, price: 200.0, side: 'BOT' });
    // Real fill 2: another 10 shares (cumulative now 20). Same ordering.
    lastFakeIb!.emit('orderStatus', orderId, 'Filled', 20, 0, 201.0);
    lastFakeIb!.emit('execDetails', 1, { symbol: 'TSLA' }, { orderId, shares: 10, price: 201.0, side: 'BOT' });

    const tracked = session.getTrackedOrder(orderId);
    // Correct final value is 20 (two real 10-share fills). The defect compounds across fills.
    expect(tracked?.filledQuantity).toBe(20);
  });
});
