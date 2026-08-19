import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trades, fills } from '../db/schema';

// Phase 3 changed OMS from a single insert to insert-then-update as the order progresses
// (PENDING at submission -> broker acceptance -> terminal fill/reject), so the mock now tracks
// a mutable "current row" that both insert and update write into, plus separate insert logs for
// `trades` vs `fills` so assertions can tell real order-lifecycle inserts apart from fill records.
const { mockDb, setExistingTrades, setThrowOnIdempotency, setEnvRow, tradesInserts, fillsInserts, getFinalTradeRow } = vi.hoisted(() => {
  const tradesInserts: any[] = [];
  const fillsInserts: any[] = [];
  let existingTrades: any[] = [];
  let currentRow: any = null;
  let throwOnIdempotency = false;
  let envRow: any = { tradingMode: 'Paper', paperMode: true };

  const selectBuilder: any = {
    from() { return selectBuilder; },
    where() { return selectBuilder; },
    limit() { return selectBuilder; },
    get() { return envRow; },
    then(resolve: any, reject: any) {
      if (throwOnIdempotency) return Promise.reject(new Error('idempotency lookup failed')).then(resolve, reject);
      return Promise.resolve(existingTrades).then(resolve, reject);
    },
  };
  const updateBuilder: any = {
    set(patch: any) { if (currentRow) Object.assign(currentRow, patch); return updateBuilder; },
    where() { return Promise.resolve({}); },
  };
  const mockDb = {
    select: () => selectBuilder,
    insert: (table: any) => ({
      values: (v: any) => {
        if (table === trades) { tradesInserts.push(v); currentRow = { ...v }; }
        else if (table === fills) { fillsInserts.push(v); }
        return Promise.resolve({});
      },
    }),
    update: () => updateBuilder,
  };
  return {
    mockDb, tradesInserts, fillsInserts,
    setExistingTrades: (rows: any[]) => { existingTrades = rows; },
    setThrowOnIdempotency: (v: boolean) => { throwOnIdempotency = v; },
    setEnvRow: (row: any) => { envRow = row; },
    getFinalTradeRow: () => currentRow,
  };
});

const { emitOrderExecution } = vi.hoisted(() => ({ emitOrderExecution: vi.fn() }));

const { mockBrokerHolder } = vi.hoisted(() => ({ mockBrokerHolder: { broker: null as any } }));
const { setTradingState } = vi.hoisted(() => ({ setTradingState: vi.fn(async () => {}) }));

vi.mock('../db', () => ({ db: mockDb }));
vi.mock('../core/EventBus', () => ({ eventBus: { on: vi.fn(), emit: vi.fn(), emitOrderExecution } }));
vi.mock('../../brokers/BrokerManager', () => ({
  BrokerManager: { getInstance: () => ({ getActiveBroker: () => mockBrokerHolder.broker }) },
}));
vi.mock('../engines/TradingEngine', () => ({
  tradingEngine: { setTradingState },
}));

import { OrderManagementService } from './OrderManagement';

describe('OrderManagementService.executeOrder', () => {
  const oms = new OrderManagementService();

  beforeEach(() => {
    tradesInserts.length = 0;
    fillsInserts.length = 0;
    emitOrderExecution.mockClear();
    setTradingState.mockClear();
    setExistingTrades([]);
    setThrowOnIdempotency(false);
    setEnvRow({ tradingMode: 'Paper', paperMode: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses to place a second order for a traceId that already has one (idempotency)', async () => {
    setExistingTrades([{ id: 'already-placed' }]);
    const placeOrder = vi.fn();
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(), positions: vi.fn() };

    await oms.executeOrder('AAPL', 'BUY', 10, 'reasoning', 'dup-trace');

    expect(placeOrder).not.toHaveBeenCalled();
    expect(tradesInserts.length).toBe(0);
  });

  it('aborts before placeOrder when the idempotency lookup throws', async () => {
    setThrowOnIdempotency(true);
    const placeOrder = vi.fn();
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(), positions: vi.fn() };

    await oms.executeOrder('AAPL', 'BUY', 10, 'reasoning', 'lookup-fail-trace');

    expect(placeOrder).not.toHaveBeenCalled();
    expect(tradesInserts.length).toBe(0);
  });

  it('inserts a PENDING row immediately at submission, before the broker call resolves', async () => {
    let resolvePlaceOrder: (v: any) => void;
    const placeOrder = vi.fn(() => new Promise(r => { resolvePlaceOrder = r; }));
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(async () => []), positions: vi.fn(async () => []) };

    const resultPromise = oms.executeOrder('AAPL', 'BUY', 10, 'reasoning', 'submit-trace');
    // Macrotask boundary - guarantees every already-queued microtask (the idempotency check and
    // the initial insert, both awaited before the broker call) has actually run, unlike counting
    // `await Promise.resolve()` calls which is fragile to exactly how many microtask hops each
    // mocked thenable takes to resolve.
    await new Promise(r => setTimeout(r, 0));

    expect(tradesInserts).toHaveLength(1);
    expect(tradesInserts[0].status).toBe('PENDING');
    expect(tradesInserts[0].submittedAt).toBeTruthy();

    resolvePlaceOrder!({ id: 'order-submit', status: 'FILLED', averageFillPrice: 100 });
    await resultPromise;
    expect(getFinalTradeRow().status).toBe('FILLED');
  });

  it('records intended price on the PENDING row so capital reservation is not $0', async () => {
    const placeOrder = vi.fn(async () => ({ id: 'order-px', status: 'FILLED', averageFillPrice: 99 }));
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(async () => []), positions: vi.fn(async () => []) };

    await oms.executeOrder('AAPL', 'BUY', 10, 'reasoning', 'price-trace', undefined, undefined, null, null, null, null, 150);
    expect(tradesInserts[0].price).toBe(150);
    expect(getFinalTradeRow().price).toBe(99);
  });

  it('places a fresh order when no prior trade exists for the traceId, and records the real fill', async () => {
    const placeOrder = vi.fn(async () => ({ id: 'order-1', status: 'FILLED', averageFillPrice: 100 }));
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(async () => []), positions: vi.fn(async () => []) };

    await oms.executeOrder('AAPL', 'BUY', 10, 'reasoning', 'fresh-trace');

    // Phase 1 (ARGUS_SAFETY_HARDENING_REPORT.md) - clientOrderId is now always passed through as
    // the real broker-level idempotency key (the local trades.id UUID, generated fresh per order
    // attempt) - asserted loosely here (a real UUID string) rather than a specific value, since
    // the id itself is generated inside executeOrder() and not observable from this test.
    expect(placeOrder).toHaveBeenCalledWith({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 10, clientOrderId: expect.any(String) });
    expect(tradesInserts).toHaveLength(1); // one order-lifecycle row, updated in place - not re-inserted
    const finalRow = getFinalTradeRow();
    expect(finalRow.status).toBe('FILLED');
    expect(finalRow.price).toBe(100);
    expect(finalRow.brokerOrderId).toBe('order-1');
    // A real fill happened - it should also land in the fills ledger.
    expect(fillsInserts).toHaveLength(1);
    expect(fillsInserts[0].price).toBe(100);
  });

  it('polls for a terminal fill when the broker initially returns PENDING, and records the real fill price', async () => {
    vi.useFakeTimers();
    const placeOrder = vi.fn(async () => ({ id: 'order-2', status: 'PENDING' }));
    const orders = vi.fn(async () => [{ id: 'order-2', status: 'FILLED', averageFillPrice: 123.45 }]);
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders, positions: vi.fn(async () => []) };

    const resultPromise = oms.executeOrder('AAPL', 'BUY', 5, 'reasoning', 'poll-trace');
    await vi.advanceTimersByTimeAsync(500);
    await resultPromise;

    const finalRow = getFinalTradeRow();
    expect(finalRow.status).toBe('FILLED');
    expect(finalRow.price).toBe(123.45);
  });

  it('records PENDING honestly (no fabricated fill) if the order never reaches a terminal state before the poll timeout', async () => {
    vi.useFakeTimers();
    const placeOrder = vi.fn(async () => ({ id: 'order-3', status: 'PENDING' }));
    const orders = vi.fn(async () => [{ id: 'order-3', status: 'PENDING' }]);
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders, positions: vi.fn(async () => []) };

    const resultPromise = oms.executeOrder('AAPL', 'BUY', 5, 'reasoning', 'timeout-trace');
    await vi.advanceTimersByTimeAsync(5000);
    await resultPromise;

    const finalRow = getFinalTradeRow();
    expect(finalRow.status).toBe('PENDING');
    expect(finalRow.price).toBe(0);
    expect(fillsInserts).toHaveLength(0); // never actually filled - no fill record fabricated
  });

  it('computes real realized P&L on a SELL fill using the pre-trade entry price', async () => {
    const placeOrder = vi.fn(async () => ({ id: 'order-4', status: 'FILLED', averageFillPrice: 120 }));
    const positions = vi.fn(async () => [{ symbol: 'AAPL', quantity: 10, entryPrice: 100 }]);
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(async () => []), positions };

    await oms.executeOrder('AAPL', 'SELL', 10, 'reasoning', 'sell-trace');

    expect(getFinalTradeRow().profitLoss).toBe(200); // (120 - 100) * 10
  });

  it('keeps PENDING and pauses trading when placeOrder throws (unknown submit is not REJECTED)', async () => {
    const placeOrder = vi.fn(async () => { throw new Error('broker down'); });
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(async () => []), positions: vi.fn(async () => []) };

    await oms.executeOrder('AAPL', 'BUY', 10, 'reasoning', 'fail-trace');

    const finalRow = getFinalTradeRow();
    expect(finalRow.status).toBe('PENDING');
    expect(finalRow.price).toBe(0);
    expect(String(finalRow.reasoning)).toMatch(/submitOutcome=UNKNOWN/);
    expect(fillsInserts).toHaveLength(0);
    expect(setTradingState).toHaveBeenCalledWith('TRADING_PAUSED', expect.objectContaining({
      reason: expect.stringContaining('placeOrder threw'),
    }));
  });

  it('LIVE + LIVE_ARM + LIVE_NO_GO refuses placeOrder', async () => {
    const prev = process.env.PAPER_TRADING_ONLY;
    process.env.PAPER_TRADING_ONLY = 'false';
    setEnvRow({ tradingMode: 'LIVE', paperMode: false });
    const { armLiveTrading, disarmLiveTrading, LIVE_TRADING_CONFIRMATION_PHRASE } = await import('../core/LiveTradingConfirmation');
    armLiveTrading(LIVE_TRADING_CONFIRMATION_PHRASE);
    const placeOrder = vi.fn(async () => ({ id: 'live-1', status: 'FILLED', averageFillPrice: 1 }));
    mockBrokerHolder.broker = {
      id: 'alpaca',
      name: 'Alpaca',
      placeOrder,
      orders: vi.fn(async () => []),
      positions: vi.fn(async () => []),
      getCapabilities: () => ({ paperTrading: true, liveTrading: true }),
    };
    try {
      await oms.executeOrder('AAPL', 'BUY', 1, 'reasoning', 'live-nogo-trace');
      expect(placeOrder).not.toHaveBeenCalled();
      expect(getFinalTradeRow().status).toBe('REJECTED');
      expect(String(getFinalTradeRow().reasoning)).toMatch(/LIVE_NO_GO/);
      // Real bug found and fixed this pass: the env-gate rejection branch used to `return` before
      // ever calling emitOrderExecution(), so ORDER_EXECUTED never fired for this outcome.
      // ORDER_SUBMITTED (emitted earlier in executeOrder) had already moved the transaction to
      // EXECUTED in TransactionLifecycleTracker, and nothing ever closed it out - a rejected
      // transaction stayed EXECUTED forever. ORDER_EXECUTED is the only event that can close it.
      expect(emitOrderExecution).toHaveBeenCalledWith(expect.objectContaining({ status: 'REJECTED' }));
    } finally {
      disarmLiveTrading();
      if (prev === undefined) delete process.env.PAPER_TRADING_ONLY;
      else process.env.PAPER_TRADING_ONLY = prev;
    }
  });

  it('PAPER orders still reach the broker when live readiness is LIVE_NO_GO', async () => {
    const placeOrder = vi.fn(async () => ({ id: 'paper-ok', status: 'FILLED', averageFillPrice: 50 }));
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(async () => []), positions: vi.fn(async () => []) };
    await oms.executeOrder('AAPL', 'BUY', 2, 'reasoning', 'paper-nogo-unaffected');
    expect(placeOrder).toHaveBeenCalled();
    expect(getFinalTradeRow().status).toBe('FILLED');
  });
});
