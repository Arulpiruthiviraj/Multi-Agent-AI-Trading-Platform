/**
 * Pluggable historical bar source for HistoricalDataGateway.
 * BrokerManager registers an IBKR fetcher when ibkr_gateway is active — avoids
 * HistoricalDataGateway importing BrokerManager (architecture allowlist).
 * Never fabricates bars; provider must return real OHLCV or throw.
 */
import type { Bar } from './HistoricalDataGateway';

export type HistoricalBarProviderId = 'ibkr_gateway' | 'alpaca' | 'cache_only';

export type HistoricalBarProvider = {
  id: HistoricalBarProviderId;
  /**
   * Fetch real bars for [startMs, endMs]. Empty array = no data (caller may fall back).
   * Must not invent prices.
   */
  fetchBars: (
    symbol: string,
    timeframe: string,
    startMs: number,
    endMs: number,
  ) => Promise<Bar[]>;
};

let registered: HistoricalBarProvider | null = null;

export function registerHistoricalBarProvider(provider: HistoricalBarProvider | null): void {
  registered = provider;
  if (provider) {
    console.log(`[HistoricalBarProvider] Active provider=${provider.id}`);
  } else {
    console.log('[HistoricalBarProvider] Cleared — Alpaca/cache path for ensureBars');
  }
}

export function getRegisteredHistoricalBarProvider(): HistoricalBarProvider | null {
  return registered;
}
