import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tradingSafety } from '../config/tradingSafety';
const feed = vi.hoisted(() => ({
  isConnected: vi.fn(), getActiveSymbols: vi.fn(), getLatestPrice: vi.fn(), getLatestPriceAgeMs: vi.fn(),
}));
vi.mock('../services/MarketDataWorker', () => ({ marketDataWorker: feed }));
import { getMarketDataReadiness } from './marketDataReadiness';

describe('market-data readiness requires observed fresh prices', () => {
  beforeEach(() => {
    feed.isConnected.mockReturnValue(true);
    feed.getActiveSymbols.mockReturnValue(['AAPL', 'SPY']);
    feed.getLatestPrice.mockReturnValue(100);
    feed.getLatestPriceAgeMs.mockReturnValue(0);
  });
  it('rejects a connected feed with occupied slots but no ticks', () => {
    feed.getLatestPrice.mockReturnValue(null);
    feed.getLatestPriceAgeMs.mockReturnValue(null);
    expect(getMarketDataReadiness()).toMatchObject({ connected: true, activeSymbols: 2, freshSymbols: 0, ready: false });
  });
  it('rejects stale quotes using the existing risk freshness threshold', () => {
    feed.getLatestPriceAgeMs.mockReturnValue(tradingSafety.stalePriceThresholdMs + 1);
    expect(getMarketDataReadiness().ready).toBe(false);
  });
  it('does not treat missing age or invalid prices as usable', () => {
    feed.getLatestPrice.mockImplementation((s) => s === 'AAPL' ? Number.NaN : 100);
    feed.getLatestPriceAgeMs.mockImplementation((s) => s === 'AAPL' ? 0 : null);
    expect(getMarketDataReadiness().freshSymbols).toBe(0);
  });
  it('reports partial coverage explicitly instead of requiring every slot to succeed', () => {
    feed.getLatestPriceAgeMs.mockImplementation((s) => s === 'AAPL' ? 0 : null);
    expect(getMarketDataReadiness()).toMatchObject({ ready: true, freshSymbols: 1, activeSymbols: 2 });
  });
  it('rejects disconnection even while previously cached quotes remain fresh', () => {
    feed.isConnected.mockReturnValue(false);
    expect(getMarketDataReadiness().ready).toBe(false);
  });
});
