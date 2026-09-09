import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * IBKR order-lifecycle crash-recovery tests (2026-09-09 P0 remediation sprint).
 *
 * Covers the invariant the sprint requires: UNKNOWN BROKER ORDER STATE MUST NEVER RESULT IN A
 * BLIND RETRY. Specifically: (a) clientOrderId (IB orderRef) round-trips correctly for orders this
 * process places, (b) reqOpenOrders()-based rehydration on connect() recovers orders a PRIOR
 * process instance placed (the actual crash-recovery scenario), (c) reqExecutions()-based recovery
 * covers an order that fully filled and dropped out of open orders before this process could
 * reconnect, and (d) the rehydration-in-flight window is distinguishable from a confirmed absence
 * so a real broker order is never mistaken for "never sent".
 *
 * findFirstOpenTcpPort is mocked (no real Gateway dependency, matching this file's sibling tests).
 * IBApi itself is mocked as a minimal EventEmitter-like stub that captures registered handlers so
 * the test can drive them directly - the same shape @stoqey/ib's real class exposes
 * (on/connect/disconnect/removeAllListeners/reqIds/reqCurrentTime/reqManagedAccts/
 * reqAccountSummary/reqPositions/reqOpenOrders/reqExecutions/placeOrder/cancelOrder), everything
 * else (EventName, OrderType, OrderAction, SecType, ErrorCode, ...) stays the real module so
 * buildIbkrOrder() and the production event-name constants are exercised for real.
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

/** Drives a fake connect through to a successful, authenticated state (mirrors the real managedAccounts handler path). */
async function connectSuccessfully(session: any) {
  lastFakeIb = null;
  const connectPromise = session.connect(false);
  // connect() awaits disconnect() then the async findFirstOpenTcpPort() mock before constructing
  // IBApi - give those microtasks a chance to run before driving the fake ib's events.
  for (let i = 0; i < 20 && !lastFakeIb; i++) {
    await new Promise((r) => setImmediate(r));
  }
  lastFakeIb!.emit('connected');
  lastFakeIb!.emit('nextValidId', 100);
  lastFakeIb!.emit('managedAccounts', 'DU1234567');
  const ok = await connectPromise;
  expect(ok).toBe(true);
}

describe('IbkrSocketSession order-lifecycle crash recovery', () => {
  beforeEach(() => {
    lastFakeIb = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('placeStockOrder tags the order with clientOrderId (orderRef) and it is retrievable via getTrackedOrderByClientOrderId', async () => {
    const { IbkrSocketSession } = await import('../IbkrSocketSession');
    const session = new IbkrSocketSession();
    await connectSuccessfully(session as any);

    const orderId = session.placeStockOrder({
      symbol: 'AAPL',
      side: 'BUY',
      quantity: 10,
      type: 'MARKET',
      clientOrderId: 'trade-uuid-1',
    });

    expect(lastFakeIb!.placeOrder).toHaveBeenCalledWith(
      orderId,
      expect.objectContaining({ symbol: 'AAPL' }),
      expect.objectContaining({ orderRef: 'trade-uuid-1' }),
    );

    const tracked = session.getTrackedOrderByClientOrderId('trade-uuid-1');
    expect(tracked?.id).toBe(orderId);
    expect(tracked?.status).toBe('PENDING');
  });

  it('rehydration is incomplete immediately after connect - not yet a confirmed absence', async () => {
    const { IbkrSocketSession } = await import('../IbkrSocketSession');
    const session = new IbkrSocketSession();
    await connectSuccessfully(session as any);

    expect(session.hasCompletedInitialRehydration()).toBe(false);
    expect(lastFakeIb!.reqOpenOrders).toHaveBeenCalledTimes(1);
    expect(lastFakeIb!.reqExecutions).toHaveBeenCalledTimes(1);
  });

  it('openOrderEnd flips rehydration to complete, and an openOrder event for an order this process never placed is rehydrated with its clientOrderId', async () => {
    const { IbkrSocketSession } = await import('../IbkrSocketSession');
    const session = new IbkrSocketSession();
    await connectSuccessfully(session as any);

    // Simulates the real crash-recovery scenario: a PRIOR process instance placed this order
    // (orderRef = a real local trades.id) and then crashed before recording anything locally.
    lastFakeIb!.emit(
      'openOrder',
      555,
      { symbol: 'MSFT' },
      { action: 'BUY', totalQuantity: 7, filledQuantity: 0, orderRef: 'prior-process-trade-id' },
      { status: 'Submitted' },
    );
    lastFakeIb!.emit('openOrderEnd');

    expect(session.hasCompletedInitialRehydration()).toBe(true);
    const tracked = session.getTrackedOrderByClientOrderId('prior-process-trade-id');
    expect(tracked).toBeDefined();
    expect(tracked?.id).toBe(555);
    expect(tracked?.symbol).toBe('MSFT');
    expect(tracked?.quantity).toBe(7);
    expect(tracked?.status).toBe('PENDING');
  });

  it('an openOrder event never overwrites an order this process already placed and tracked', async () => {
    const { IbkrSocketSession } = await import('../IbkrSocketSession');
    const session = new IbkrSocketSession();
    await connectSuccessfully(session as any);

    const orderId = session.placeStockOrder({
      symbol: 'AAPL',
      side: 'BUY',
      quantity: 10,
      type: 'MARKET',
      clientOrderId: 'my-own-order',
    });

    // IB echoes the open order back (normal behavior even for orders this same session placed).
    lastFakeIb!.emit(
      'openOrder',
      orderId,
      { symbol: 'AAPL' },
      { action: 'BUY', totalQuantity: 999, filledQuantity: 999, orderRef: 'my-own-order' },
      { status: 'Filled' },
    );

    // Local in-memory state (set synchronously by placeStockOrder) must not be clobbered by the
    // echo - orderStatus/execDetails are the real source of truth for status transitions, not a
    // stale openOrder snapshot racing against them.
    const tracked = session.getTrackedOrder(orderId);
    expect(tracked?.quantity).toBe(10);
    expect(tracked?.status).toBe('PENDING');
  });

  it('an execDetails event for an order never seen via openOrder (fully filled and already dropped from open orders) is rehydrated using the execution\'s own orderRef', async () => {
    const { IbkrSocketSession } = await import('../IbkrSocketSession');
    const session = new IbkrSocketSession();
    await connectSuccessfully(session as any);
    lastFakeIb!.emit('openOrderEnd'); // no open orders reported - order already fully filled

    lastFakeIb!.emit(
      'execDetails',
      1,
      { symbol: 'NVDA' },
      { orderId: 777, shares: 25, price: 450.5, side: 'BOT', orderRef: 'fully-filled-before-reconnect' },
    );

    const tracked = session.getTrackedOrderByClientOrderId('fully-filled-before-reconnect');
    expect(tracked).toBeDefined();
    expect(tracked?.id).toBe(777);
    expect(tracked?.symbol).toBe('NVDA');
    expect(tracked?.side).toBe('BUY');
    expect(tracked?.filledQuantity).toBe(25);
    expect(tracked?.status).toBe('FILLED');
    expect(tracked?.averageFillPrice).toBe(450.5);
  });

  it('a second execDetails for the same rehydrated order accumulates fill quantity rather than losing the first partial fill', async () => {
    const { IbkrSocketSession } = await import('../IbkrSocketSession');
    const session = new IbkrSocketSession();
    await connectSuccessfully(session as any);

    lastFakeIb!.emit('execDetails', 1, { symbol: 'TSLA' }, { orderId: 888, shares: 10, price: 200, side: 'BOT', orderRef: 'multi-fill-order' });
    lastFakeIb!.emit('execDetails', 1, { symbol: 'TSLA' }, { orderId: 888, shares: 15, price: 202, side: 'BOT', orderRef: 'multi-fill-order' });

    const tracked = session.getTrackedOrderByClientOrderId('multi-fill-order');
    expect(tracked?.filledQuantity).toBe(25);
    // Weighted average: (10*200 + 15*202) / 25 = 201.2
    expect(tracked?.averageFillPrice).toBeCloseTo(201.2, 5);
  });

  it('reconnect resets rehydration state - a fresh connect() cycle requires a fresh openOrderEnd before being trusted again', async () => {
    const { IbkrSocketSession } = await import('../IbkrSocketSession');
    const session = new IbkrSocketSession();
    await connectSuccessfully(session as any);
    lastFakeIb!.emit('openOrderEnd');
    expect(session.hasCompletedInitialRehydration()).toBe(true);

    await connectSuccessfully(session as any); // second connect() cycle (new fake ib instance)
    expect(session.hasCompletedInitialRehydration()).toBe(false);
  });
});
