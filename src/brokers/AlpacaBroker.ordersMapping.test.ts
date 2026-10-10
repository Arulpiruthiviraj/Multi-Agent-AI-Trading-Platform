import { describe, it, expect, vi, afterEach } from 'vitest';
import { AlpacaBroker } from './AlpacaBroker';

// 2026-10-10 (backend defect hunt): orders() mapped every Alpaca order row with
// o.side.toUpperCase() / o.order_type.toUpperCase() and parseFloat(o.qty) inline.
// One malformed row (missing side, missing order_type) threw a TypeError that killed
// the ENTIRE orders() call - not just the bad row - so OMS follow-up, the
// reconciliation orphan scan, and the orchestration/capital snapshot all lost every
// order, not one. A malformed qty produced NaN, violating the Order contract the
// same way the 2026-10-05 P1 positions fix addressed in portfolio().
// Fix: validate per-row (skip + loud log), map unparseable optional numerics to
// undefined, and fail loudly on a non-array payload.
function brokerWithOrders(rows: any): AlpacaBroker {
  const broker = new AlpacaBroker();
  vi.spyOn(broker as any, 'fetchAlpaca').mockResolvedValue(rows);
  return broker;
}

const goodOrder = {
  id: 'ord-1',
  symbol: 'AAPL',
  side: 'buy',
  order_type: 'market',
  status: 'filled',
  qty: '10',
  filled_qty: '10',
  filled_avg_price: '150.25',
  client_order_id: 'argus-1',
  created_at: '2026-10-10T10:00:00Z',
  updated_at: '2026-10-10T10:00:01Z',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AlpacaBroker.orders() malformed-row hardening', () => {
  it('skips a row missing side (loudly) instead of throwing away the whole order list', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broker = brokerWithOrders([goodOrder, { ...goodOrder, id: 'ord-bad', side: undefined }]);
    const orders = await broker.orders();
    expect(orders.map((o) => o.id)).toEqual(['ord-1']);
    expect(errSpy).toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0][0])).toContain('ord-bad');
  });

  it('skips a row with unparseable qty instead of emitting NaN', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const broker = brokerWithOrders([goodOrder, { ...goodOrder, id: 'ord-nan', qty: 'not-a-number' }]);
    const orders = await broker.orders();
    expect(orders.map((o) => o.id)).toEqual(['ord-1']);
    for (const o of orders) {
      expect(Number.isFinite(o.quantity)).toBe(true);
    }
  });

  it('maps a missing filled_qty to undefined (never NaN)', async () => {
    const broker = brokerWithOrders([{ ...goodOrder, filled_qty: undefined }]);
    const orders = await broker.orders();
    expect(orders).toHaveLength(1);
    expect(orders[0].filledQuantity).toBeUndefined();
  });

  it('throws a clear error (not a TypeError from .map) on a non-array payload', async () => {
    const broker = brokerWithOrders({ code: 500, message: 'internal error' } as any);
    await expect(broker.orders()).rejects.toThrow(/expected an array/i);
  });

  it('still maps a fully valid order list unchanged', async () => {
    const broker = brokerWithOrders([goodOrder, { ...goodOrder, id: 'ord-2', symbol: 'MSFT' }]);
    const orders = await broker.orders();
    expect(orders).toHaveLength(2);
    expect(orders[0]).toMatchObject({
      id: 'ord-1',
      symbol: 'AAPL',
      side: 'BUY',
      type: 'MARKET',
      status: 'FILLED',
      quantity: 10,
      filledQuantity: 10,
      averageFillPrice: 150.25,
      clientOrderId: 'argus-1',
    });
  });
});

describe('AlpacaBroker.getOrderByClientOrderId() malformed-row hardening', () => {
  it('returns null (not a throw) when the matched row is malformed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const broker = new AlpacaBroker();
    vi.spyOn(broker as any, 'fetchAlpaca').mockResolvedValue([
      { ...goodOrder, side: undefined },
    ]);
    await expect(broker.getOrderByClientOrderId('argus-1')).resolves.toBeNull();
  });
});
