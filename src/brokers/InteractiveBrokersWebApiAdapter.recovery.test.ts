import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../server/config/ibkrConnection', () => ({
  loadIbkrConnection: () => ({ webApiRequestTimeoutMs: 5000 }),
}));

import { InteractiveBrokersWebApiAdapter } from './InteractiveBrokersWebApiAdapter';

/**
 * Real defect (2026-10-08 defect hunt, execution D1): InteractiveBrokersWebApiAdapter had no
 * getOrderByClientOrderId, so crash recovery silently skipped every ibkr_web PENDING row with
 * a NULL brokerOrderId (the DEF-30 class, reopened for the other IBKR adapter). The adapter
 * also never sent our client order id to IBKR, so there was nothing to look up by.
 * Now: placeOrder sends cOID (round-trips as order_ref), and getOrderByClientOrderId follows
 * the IBKR-gateway discipline - throw on ambiguity, never fabricate a confirmed absence.
 */
describe('InteractiveBrokersWebApiAdapter crash-recovery lookup (D1)', () => {
  let adapter: InteractiveBrokersWebApiAdapter;
  let postedBodies: any[];

  beforeEach(() => {
    adapter = new InteractiveBrokersWebApiAdapter();
    (adapter as any).isAuthenticated = true;
    postedBodies = [];
    (adapter as any).request = vi.fn(async (path: string, options: any = {}) => {
      if (path === '/portfolio/accounts') return [{ id: 'DU123' }];
      if (path.startsWith('/iserver/secdef/search')) return [{ symbol: 'AAPL', conid: 265598 }];
      if (path.endsWith('/orders') && options.method === 'POST') {
        postedBodies.push(options.body);
        return [{ order_id: '999', order_status: 'Submitted' }];
      }
      if (path === '/iserver/account/orders') {
        return (adapter as any).__liveOrders ?? [];
      }
      throw new Error(`unexpected request in test: ${path}`);
    });
    // assertIbkrSessionAllowsOrder gate: satisfy via the adapter's own requestedMode default.
    (adapter as any).requestedMode = 'PAPER';
  });

  it('placeOrder sends our clientOrderId as IBKR cOID', async () => {
    await adapter.placeOrder({ symbol: 'AAPL', side: 'BUY', quantity: 10, clientOrderId: 'trace_AAPL_123_ab12' });
    expect(postedBodies.length).toBe(1);
    expect(postedBodies[0].orders[0].cOID).toBe('trace_AAPL_123_ab12');
  });

  it('placeOrder truncates an over-long clientOrderId to the 64-char cOID limit', async () => {
    await adapter.placeOrder({ symbol: 'AAPL', side: 'BUY', quantity: 10, clientOrderId: 'x'.repeat(100) });
    expect(postedBodies[0].orders[0].cOID).toHaveLength(64);
  });

  it('getOrderByClientOrderId returns the live order matched by order_ref', async () => {
    (adapter as any).__liveOrders = [
      { orderId: 999, order_ref: 'trace_AAPL_123_ab12', ticker: 'AAPL', side: 'BUY', orderType: 'MKT', status: 'Submitted', totalSize: 10, filledQuantity: 0 },
      { orderId: 1000, order_ref: 'other-id', ticker: 'MSFT', side: 'BUY', orderType: 'MKT', status: 'Filled', totalSize: 5, filledQuantity: 5 },
    ];
    const found = await adapter.getOrderByClientOrderId('trace_AAPL_123_ab12');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('999');
    expect(found!.clientOrderId).toBe('trace_AAPL_123_ab12');
  });

  it('getOrderByClientOrderId THROWS (never null) when the order is not in the live list - absence is not confirmable', async () => {
    (adapter as any).__liveOrders = [];
    // A null return would let OMS mark the row REJECTED as "confirmed never reached" - but a
    // filled order leaves the CP live-orders list, so absence proves nothing. Throwing makes
    // OMS retry next cycle instead of fabricating a reconciliation result.
    await expect(adapter.getOrderByClientOrderId('trace_AAPL_123_ab12')).rejects.toThrow(/not confirmed absent/);
  });

  it('getOrderByClientOrderId THROWS when the session is not authenticated', async () => {
    (adapter as any).isAuthenticated = false;
    await expect(adapter.getOrderByClientOrderId('trace_AAPL_123_ab12')).rejects.toThrow(/not authenticated/);
  });
});
