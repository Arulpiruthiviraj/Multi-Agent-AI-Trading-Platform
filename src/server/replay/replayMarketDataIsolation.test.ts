import { describe, expect, it } from 'vitest';
import { marketDataWorker } from '../services/MarketDataWorker';
import { cacheReplayQuote, clearReplayQuotes, getReplayQuote, replayQuoteCount } from './HistoricalReplayMarketDataContext';

describe('HistoricalReplayMarketDataContext isolation', () => {
  it('replay quote mutation cannot modify live MarketDataWorker cache', () => {
    clearReplayQuotes();
    const before = marketDataWorker.getLatestPrice('SPY');
    cacheReplayQuote('SPY', 999.99, 1_700_000_000_000);
    expect(getReplayQuote('SPY')).toBe(999.99);
    expect(replayQuoteCount()).toBe(1);
    expect(marketDataWorker.getLatestPrice('SPY')).toBe(before);
    clearReplayQuotes();
    expect(getReplayQuote('SPY')).toBeNull();
  });
});
