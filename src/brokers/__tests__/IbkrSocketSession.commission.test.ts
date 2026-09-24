import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Real commission attribution (Priority 13, 2026-09-23). IB's commissionReport event carries only
 * `execId` + `commission` - no orderId. IbkrSocketSession attributes it to the correct local order
 * by joining on execId against the SAME execId the execDetails handler already tracks (real,
 * IB-native, per-execution identifier - see DEF-30's execId dedup work, IbkrSocketSession.
 * fillAccounting.test.ts sibling file). Same mock harness/pattern as that file.
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

describe('IbkrSocketSession commission attribution (Priority 13)', () => {
  beforeEach(() => {
    lastFakeIb = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('attributes a real commissionReport to the correct order via a matching execId', async () => {
    const { IbkrSocketSession } = await import('../IbkrSocketSession');
    const session = new IbkrSocketSession();
    await connectSuccessfully(session as any);

    const orderId = session.placeStockOrder({
      symbol: 'AAPL', side: 'BUY', quantity: 10, type: 'MARKET', clientOrderId: 'commission-order-1',
    });

    lastFakeIb!.emit('execDetails', 1, { symbol: 'AAPL' }, { orderId, shares: 10, price: 150.0, side: 'BOT', execId: 'exec-c-1' });
    lastFakeIb!.emit('commissionReport', { execId: 'exec-c-1', commission: 1.23, currency: 'USD' });

    expect(session.getAggregateCommissionForOrder(orderId)).toBeCloseTo(1.23, 6);
  });

  it('sums commission across multiple real executions of the same order', async () => {
    const { IbkrSocketSession } = await import('../IbkrSocketSession');
    const session = new IbkrSocketSession();
    await connectSuccessfully(session as any);

    const orderId = session.placeStockOrder({
      symbol: 'MSFT', side: 'BUY', quantity: 20, type: 'MARKET', clientOrderId: 'commission-order-2',
    });

    lastFakeIb!.emit('execDetails', 1, { symbol: 'MSFT' }, { orderId, shares: 10, price: 300.0, side: 'BOT', execId: 'exec-c-2a' });
    lastFakeIb!.emit('execDetails', 1, { symbol: 'MSFT' }, { orderId, shares: 10, price: 301.0, side: 'BOT', execId: 'exec-c-2b' });
    lastFakeIb!.emit('commissionReport', { execId: 'exec-c-2a', commission: 1.0 });
    lastFakeIb!.emit('commissionReport', { execId: 'exec-c-2b', commission: 1.1 });

    expect(session.getAggregateCommissionForOrder(orderId)).toBeCloseTo(2.1, 6);
  });

  it('returns null (never zero) when no commissionReport has arrived yet for this order - not a guess', async () => {
    const { IbkrSocketSession } = await import('../IbkrSocketSession');
    const session = new IbkrSocketSession();
    await connectSuccessfully(session as any);

    const orderId = session.placeStockOrder({
      symbol: 'TSLA', side: 'BUY', quantity: 5, type: 'MARKET', clientOrderId: 'commission-order-3',
    });
    lastFakeIb!.emit('execDetails', 1, { symbol: 'TSLA' }, { orderId, shares: 5, price: 200.0, side: 'BOT', execId: 'exec-c-3' });

    expect(session.getAggregateCommissionForOrder(orderId)).toBeNull();
  });

  it('a commissionReport whose execId was never seen via execDetails is never attributed to any order (no guess by timing/ordering)', async () => {
    const { IbkrSocketSession } = await import('../IbkrSocketSession');
    const session = new IbkrSocketSession();
    await connectSuccessfully(session as any);

    const orderId = session.placeStockOrder({
      symbol: 'GOOGL', side: 'BUY', quantity: 5, type: 'MARKET', clientOrderId: 'commission-order-4',
    });
    lastFakeIb!.emit('execDetails', 1, { symbol: 'GOOGL' }, { orderId, shares: 5, price: 175.0, side: 'BOT', execId: 'exec-c-4' });
    // Unrelated commission report for an execId this order never produced.
    lastFakeIb!.emit('commissionReport', { execId: 'exec-never-seen', commission: 9.99 });

    expect(session.getAggregateCommissionForOrder(orderId)).toBeNull();
  });

  it('a duplicate/replayed commissionReport for the same execId is an idempotent overwrite, never a double-count', async () => {
    const { IbkrSocketSession } = await import('../IbkrSocketSession');
    const session = new IbkrSocketSession();
    await connectSuccessfully(session as any);

    const orderId = session.placeStockOrder({
      symbol: 'AMZN', side: 'BUY', quantity: 10, type: 'MARKET', clientOrderId: 'commission-order-5',
    });
    lastFakeIb!.emit('execDetails', 1, { symbol: 'AMZN' }, { orderId, shares: 10, price: 140.0, side: 'BOT', execId: 'exec-c-5' });
    lastFakeIb!.emit('commissionReport', { execId: 'exec-c-5', commission: 1.5 });
    lastFakeIb!.emit('commissionReport', { execId: 'exec-c-5', commission: 1.5 });
    lastFakeIb!.emit('commissionReport', { execId: 'exec-c-5', commission: 1.5 });

    expect(session.getAggregateCommissionForOrder(orderId)).toBeCloseTo(1.5, 6); // not 4.5
  });
});
