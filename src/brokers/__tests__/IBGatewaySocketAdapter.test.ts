import { describe, it, expect, vi } from 'vitest';
import { IBGatewaySocketAdapter } from '../IBGatewaySocketAdapter';

describe('IBGatewaySocketAdapter', () => {
  it('exposes socket capabilities without browser reauth', () => {
    const a = new IBGatewaySocketAdapter();
    expect(a.id).toBe('ibkr_gateway');
    expect(a.name).toMatch(/Gateway/i);
    const caps = a.getCapabilities();
    expect(caps.canPlaceOrders).toBe(true);
    expect(caps.streamingMarketData).toBe(true);
    expect(caps.requiresManualReauth).toBe(false);
    expect(caps.canadianEquities).toBe(false);
  });

  it('getConnectionSnapshot reports IB_GATEWAY_SOCKET adapter', () => {
    const a = new IBGatewaySocketAdapter();
    const snap = a.getConnectionSnapshot();
    expect(snap.adapter).toBe('IB_GATEWAY_SOCKET');
    expect(snap.requiresManualReauth).toBe(false);
  });

  it('placeOrder refuses when socket is not connected', async () => {
    const a = new IBGatewaySocketAdapter();
    a.paperTrading();
    await expect(
      a.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1 }),
    ).rejects.toThrow(/not connected/i);
  });

  it('getHistoricalBars refuses when socket is not connected', async () => {
    const a = new IBGatewaySocketAdapter();
    await expect(
      a.getHistoricalBars('AAPL', '1Day', Date.now() - 86_400_000 * 30, Date.now()),
    ).rejects.toThrow(/not connected/i);
  });

  // 2026-09-04 opportunity-capture remediation: a rejected reqMktData request used to vanish
  // silently once the initial connect handshake had settled. setMarketDataErrorHandler/
  // getMarketDataError pass through to the underlying session so BrokerManager can wire real IB
  // rejections into MarketDataWorker's observability surface.
  it('passes setMarketDataErrorHandler/getMarketDataError through to the session', () => {
    const a = new IBGatewaySocketAdapter();
    const handler = vi.fn();
    a.setMarketDataErrorHandler(handler);
    const session: any = (a as any).session;
    session.activeMktData.set(1, 'NVDA');
    session.handleMarketDataError(1, 354, 'Requested market data is not subscribed.');
    expect(handler).toHaveBeenCalledWith('NVDA', 354, 'Requested market data is not subscribed.');
    expect(a.getMarketDataError('NVDA')?.code).toBe(354);
    expect(a.getMarketDataError('AAPL')).toBeNull();
  });
});
