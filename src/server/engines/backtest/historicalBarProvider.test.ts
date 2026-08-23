import { describe, it, expect, afterEach } from 'vitest';
import {
  registerHistoricalBarProvider,
  getRegisteredHistoricalBarProvider,
} from './historicalBarProvider';
import { expectedBarCountForWindow } from './HistoricalDataGateway';

describe('historicalBarProvider', () => {
  afterEach(() => {
    registerHistoricalBarProvider(null);
  });

  it('registers and clears the IBKR provider without importing BrokerManager', () => {
    expect(getRegisteredHistoricalBarProvider()).toBeNull();
    registerHistoricalBarProvider({
      id: 'ibkr_gateway',
      fetchBars: async () => [],
    });
    expect(getRegisteredHistoricalBarProvider()?.id).toBe('ibkr_gateway');
    registerHistoricalBarProvider(null);
    expect(getRegisteredHistoricalBarProvider()).toBeNull();
  });
});

describe('expectedBarCountForWindow', () => {
  it('estimates daily coverage for Quant lookback', () => {
    const end = Date.UTC(2026, 0, 100);
    const start = end - 400 * 86_400_000;
    expect(expectedBarCountForWindow('1Day', start, end)).toBe(400);
  });
});
