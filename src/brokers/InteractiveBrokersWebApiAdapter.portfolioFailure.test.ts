import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../server/config/ibkrConnection', () => ({
  loadIbkrConnection: () => ({ webApiRequestTimeoutMs: 5000 }),
}));

import { InteractiveBrokersWebApiAdapter } from './InteractiveBrokersWebApiAdapter';

/**
 * 2026-10-10 (full-stack defect hunt, cross-cutting adjudication 6b):
 * portfolio() swallowed EVERY positions-request failure (auth loss, timeout,
 * connection error, HTTP 4xx/5xx) into an empty positions list via
 * `.catch(() => [])`. A fabricated empty list is indistinguishable from "the
 * broker genuinely has no positions", so RiskEngine gate 23 could approve a
 * trade that conflicts with real (but unobservable) positions. The summary
 * request already threw on failure; only the positions leg was dishonest.
 * Failure must now throw so callers see a diagnosable error (TradingEngine
 * budget checks and ArgusCoreBoot wrap portfolio() in try/catch; RiskEngine's
 * evaluateRiskSerialized has a top-level fail-closed catch). Same hazard class
 * as the same-day orders() fix (D1 throw-on-ambiguity, 2026-10-08).
 */
describe('InteractiveBrokersWebApiAdapter.portfolio() failure honesty', () => {
  let adapter: InteractiveBrokersWebApiAdapter;

  beforeEach(() => {
    adapter = new InteractiveBrokersWebApiAdapter();
    (adapter as any).isAuthenticated = true;
  });

  const mockSummaryOk = (requestMock: any) =>
    requestMock.mockImplementation(async (path: string) => {
      if (path === '/portfolio/accounts') return [{ id: 'TEST123' }] as any;
      if (path.includes('/summary')) {
        return { totalcashvalue: { amount: 10000 }, netliquidation: { amount: 15000 } } as any;
      }
      if (path.includes('/positions/')) {
        throw new Error('BROKER_TIMEOUT: IBKR Gateway GET /portfolio/TEST123/positions/0 timed out');
      }
      return {} as any;
    });

  it('throws (does not return empty positions) when the positions request fails', async () => {
    const requestMock = vi.fn();
    (adapter as any).request = requestMock;
    mockSummaryOk(requestMock);
    await expect(adapter.portfolio()).rejects.toThrow(/timed out/);
  });

  it('throws (does not return empty positions) when the session drops mid-call', async () => {
    (adapter as any).request = vi.fn(async (path: string) => {
      if (path === '/portfolio/accounts') return [{ id: 'TEST123' }] as any;
      if (path.includes('/summary')) {
        return { totalcashvalue: { amount: 10000 }, netliquidation: { amount: 15000 } } as any;
      }
      throw new Error('IBKR Gateway GET /portfolio/TEST123/positions/0 -> 401: Access Denied');
    });
    await expect(adapter.portfolio()).rejects.toThrow(/401/);
  });

  it('still returns mapped positions when the request succeeds', async () => {
    (adapter as any).request = vi.fn(async (path: string) => {
      if (path === '/portfolio/accounts') return [{ id: 'TEST123' }] as any;
      if (path.includes('/summary')) {
        return { totalcashvalue: { amount: 10000 }, netliquidation: { amount: 15000 } } as any;
      }
      if (path.includes('/positions/')) {
        return [{ contractDesc: 'AAPL', position: 10, avgCost: 150, mktPrice: 160, mktValue: 1600 }] as any;
      }
      return {} as any;
    });
    const portfolio = await adapter.portfolio();
    expect(portfolio.positions).toHaveLength(1);
    expect(portfolio.positions[0]).toMatchObject({ symbol: 'AAPL', entryPrice: 150, currentPrice: 160 });
  });
});
