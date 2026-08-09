import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trades } from '../db/schema';

const { mockDb, setExistingTrades, insertedRows } = vi.hoisted(() => {
  const insertedRows: any[] = [];
  let existingTrades: any[] = [];
  const selectBuilder: any = {
    from() { return selectBuilder; },
    where() { return selectBuilder; },
    limit() { return selectBuilder; },
    then(resolve: any, reject: any) {
      return Promise.resolve(existingTrades).then(resolve, reject);
    },
  };
  const mockDb = {
    select: () => selectBuilder,
    insert: () => ({
      values: (v: any) => {
        insertedRows.push(v);
        return Promise.resolve({});
      },
    }),
  };
  return {
    mockDb,
    insertedRows,
    setExistingTrades: (rows: any[]) => { existingTrades = rows; },
  };
});

const { emitOrderExecution } = vi.hoisted(() => ({ emitOrderExecution: vi.fn() }));

const { mockBrokerHolder } = vi.hoisted(() => ({ mockBrokerHolder: { broker: null as any } }));

vi.mock('../db', () => ({ db: mockDb }));
vi.mock('../core/EventBus', () => ({ eventBus: { on: vi.fn(), emitOrderExecution } }));
vi.mock('../../brokers/BrokerManager', () => ({
  BrokerManager: { getInstance: () => ({ getActiveBroker: () => mockBrokerHolder.broker }) },
}));

import { OrderManagementService } from './OrderManagement';

describe('OrderManagementService.executeOrder', () => {
  const oms = new OrderManagementService();

  beforeEach(() => {
    insertedRows.length = 0;
    emitOrderExecution.mockClear();
    setExistingTrades([]);
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
    expect(insertedRows.length).toBe(0);
  });

  it('places a fresh order when no prior trade exists for the traceId', async () => {
    const placeOrder = vi.fn(async () => ({ id: 'order-1', status: 'FILLED', averageFillPrice: 100 }));
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(async () => []), positions: vi.fn(async () => []) };

    await oms.executeOrder('AAPL', 'BUY', 10, 'reasoning', 'fresh-trace');

    expect(placeOrder).toHaveBeenCalledWith({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 10 });
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].status).toBe('FILLED');
    expect(insertedRows[0].price).toBe(100);
  });

  it('polls for a terminal fill when the broker initially returns PENDING, and records the real fill price', async () => {
    vi.useFakeTimers();
    const placeOrder = vi.fn(async () => ({ id: 'order-2', status: 'PENDING' }));
    const orders = vi.fn(async () => [{ id: 'order-2', status: 'FILLED', averageFillPrice: 123.45 }]);
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders, positions: vi.fn(async () => []) };

    const resultPromise = oms.executeOrder('AAPL', 'BUY', 5, 'reasoning', 'poll-trace');
    await vi.advanceTimersByTimeAsync(500);
    await resultPromise;

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].status).toBe('FILLED');
    expect(insertedRows[0].price).toBe(123.45);
  });

  it('records PENDING honestly (no fabricated fill) if the order never reaches a terminal state before the poll timeout', async () => {
    vi.useFakeTimers();
    const placeOrder = vi.fn(async () => ({ id: 'order-3', status: 'PENDING' }));
    const orders = vi.fn(async () => [{ id: 'order-3', status: 'PENDING' }]);
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders, positions: vi.fn(async () => []) };

    const resultPromise = oms.executeOrder('AAPL', 'BUY', 5, 'reasoning', 'timeout-trace');
    await vi.advanceTimersByTimeAsync(5000);
    await resultPromise;

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].status).toBe('PENDING');
    expect(insertedRows[0].price).toBe(0);
  });

  it('computes real realized P&L on a SELL fill using the pre-trade entry price', async () => {
    const placeOrder = vi.fn(async () => ({ id: 'order-4', status: 'FILLED', averageFillPrice: 120 }));
    const positions = vi.fn(async () => [{ symbol: 'AAPL', quantity: 10, entryPrice: 100 }]);
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(async () => []), positions };

    await oms.executeOrder('AAPL', 'SELL', 10, 'reasoning', 'sell-trace');

    expect(insertedRows[0].profitLoss).toBe(200); // (120 - 100) * 10
  });

  it('records REJECTED (not a fabricated fill) when the broker throws', async () => {
    const placeOrder = vi.fn(async () => { throw new Error('broker down'); });
    mockBrokerHolder.broker = { name: 'Test', placeOrder, orders: vi.fn(async () => []), positions: vi.fn(async () => []) };

    await oms.executeOrder('AAPL', 'BUY', 10, 'reasoning', 'fail-trace');

    expect(insertedRows[0].status).toBe('REJECTED');
    expect(insertedRows[0].price).toBe(0);
  });
});
