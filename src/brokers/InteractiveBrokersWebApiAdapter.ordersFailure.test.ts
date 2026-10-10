import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../server/config/ibkrConnection', () => ({
  loadIbkrConnection: () => ({ webApiRequestTimeoutMs: 5000 }),
}));

import { InteractiveBrokersWebApiAdapter } from './InteractiveBrokersWebApiAdapter';

/**
 * 2026-10-10 (backend defect hunt): orders() swallowed EVERY request failure
 * (auth loss, timeout, connection error, HTTP 4xx/5xx) into an empty list via
 * `.catch(() => [])`. An empty list is indistinguishable from "the broker
 * genuinely has no orders", so OMS follow-up, pollForFill, and the reconciliation
 * orphan scan all proceeded as if every tracked order had vanished from the
 * broker - instead of the immediate, diagnosable failure every caller already
 * handles (pollForFill warns+retries, follow-up skips the broker, the
 * orchestration snapshot falls back to local pending buys). This contradicts the
 * adapter's own 2026-10-08 D1 discipline (getOrderByClientOrderId throws on
 * ambiguity rather than fabricating an answer).
 */
describe('InteractiveBrokersWebApiAdapter.orders() failure honesty', () => {
  let adapter: InteractiveBrokersWebApiAdapter;

  beforeEach(() => {
    adapter = new InteractiveBrokersWebApiAdapter();
    (adapter as any).isAuthenticated = true;
  });

  it('throws (does not return []) when the order-list request fails', async () => {
    (adapter as any).request = vi.fn(async () => {
      throw new Error('BROKER_TIMEOUT: IBKR Gateway GET /iserver/account/orders timed out');
    });
    await expect(adapter.orders()).rejects.toThrow(/timed out/);
  });

  it('throws (does not return []) when the session drops mid-call', async () => {
    (adapter as any).request = vi.fn(async () => {
      throw new Error('IBKR Gateway GET /iserver/account/orders -> 401: Access Denied');
    });
    await expect(adapter.orders()).rejects.toThrow(/401/);
  });

  it('still returns mapped orders when the request succeeds', async () => {
    (adapter as any).request = vi.fn(async () => [
      { orderId: 999, ticker: 'AAPL', side: 'BUY', orderType: 'MKT', status: 'Submitted', totalSize: 10, filledQuantity: 0 },
    ]);
    const orders = await adapter.orders();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ id: '999', symbol: 'AAPL', side: 'BUY', status: 'PENDING', quantity: 10 });
  });
});
