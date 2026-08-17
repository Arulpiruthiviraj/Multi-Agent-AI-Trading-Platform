import { describe, it, expect } from 'vitest';
import { Bar } from '../engines/backtest/HistoricalDataGateway';
import { getMarketContext, BarsFetcher, SECTOR_ETF_MAP } from './MarketContext';

function makeTrendingBars(count: number, startPrice: number, driftPerBar: number): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const close = startPrice + i * driftPerBar;
    return { timestamp: i * 86_400_000, open: close, close, high: close * 1.005, low: close * 0.995, volume: 1_000_000 };
  });
}

describe('MarketContext.getMarketContext', () => {
  const fakeFetcher: BarsFetcher = async (symbol) => {
    // SPY/XLK trend up, QQQ trends up faster (for relative-strength differentiation), IWM flat.
    if (symbol === 'SPY') return makeTrendingBars(220, 400, 0.3);
    if (symbol === 'QQQ') return makeTrendingBars(220, 350, 0.6);
    if (symbol === 'IWM') return Array.from({ length: 220 }, (_, i) => ({
      timestamp: i * 86_400_000, open: 200, close: 200, high: 201, low: 199, volume: 500_000,
    }));
    if (symbol === 'XLK') return makeTrendingBars(220, 180, 0.25);
    return [];
  };

  it('reports a real regime for each real benchmark, source-tagged', async () => {
    const symbolBars = makeTrendingBars(220, 150, 0.4); // outperforming SPY's 0.3/bar drift
    const result = await getMarketContext('AAPL', symbolBars, '1Day', 0, 220 * 86_400_000, fakeFetcher);

    expect(result.spy.regime).not.toBeNull();
    expect(result.spy.regime?.regime).toBe('BULLISH_TREND');
    expect(result.spy.source).toContain('SPY');
    expect(result.iwm.regime?.regime).toBe('SIDEWAYS_RANGE');
  });

  it('computes real relative strength vs SPY (AAPL genuinely outperforming in this fixture)', async () => {
    const symbolBars = makeTrendingBars(220, 150, 0.4);
    const result = await getMarketContext('AAPL', symbolBars, '1Day', 0, 220 * 86_400_000, fakeFetcher);

    expect(result.relativeStrengthVsSPY).not.toBeNull();
    expect(result.relativeStrengthVsSPY!.relativeStrengthPct).not.toBeNull();
    expect(result.relativeStrengthVsSPY!.relativeStrengthPct as number).toBeGreaterThan(0);
  });

  it('resolves AAPL\'s real sector (Technology) to its real ETF proxy (XLK) via the existing PositionSizing.getSector, without touching PositionSizing.ts', async () => {
    const symbolBars = makeTrendingBars(220, 150, 0.4);
    const result = await getMarketContext('AAPL', symbolBars, '1Day', 0, 220 * 86_400_000, fakeFetcher);

    expect(result.sector.name).toBe('Technology');
    expect(result.sector.etf).toBe(SECTOR_ETF_MAP['Technology']);
    expect(result.sector.trend).not.toBeNull();
  });

  it('honestly reports sector as unavailable for a symbol PositionSizing.SECTOR_MAP does not cover', async () => {
    const symbolBars = makeTrendingBars(220, 50, 0.1);
    const result = await getMarketContext('ZZZZ_UNMAPPED', symbolBars, '1Day', 0, 220 * 86_400_000, fakeFetcher);

    expect(result.sector.name).toBeNull();
    expect(result.sector.etf).toBeNull();
    expect(result.sector.trend).toBeNull();
    expect(result.relativeStrengthVsSector).toBeNull();
  });

  it('never fabricates breadth metrics - always honestly unavailable', async () => {
    const symbolBars = makeTrendingBars(220, 150, 0.4);
    const result = await getMarketContext('AAPL', symbolBars, '1Day', 0, 220 * 86_400_000, fakeFetcher);
    expect(result.breadth.available).toBe(false);
    expect(result.breadth.reason.length).toBeGreaterThan(0);
  });

  it('handles a real fetch failure honestly (regime null, error captured in source) rather than throwing or fabricating', async () => {
    const failingFetcher: BarsFetcher = async (symbol) => {
      if (symbol === 'SPY') throw new Error('simulated Alpaca outage');
      return [];
    };
    const result = await getMarketContext('AAPL', [], '1Day', 0, 1000, failingFetcher);
    expect(result.spy.regime).toBeNull();
    expect(result.spy.source).toContain('simulated Alpaca outage');
  });

  // Real bug fixed: correlation/beta used to be computed on raw closing PRICE LEVELS instead of
  // period returns. Two series sharing the same overall linear trend but with independent,
  // uncorrelated day-to-day noise show near-perfect price-level correlation (both are ~straight
  // lines trending the same direction) even though their actual day-to-day co-movement is weak -
  // exactly the spurious-correlation failure mode the fix closes.
  it('reports real return-based correlation, not spurious price-level correlation from a shared trend', async () => {
    const days = 220;
    // Same linear drift as the shared trend (so raw price levels for both series correlate
    // strongly), but each has its own independent oscillation added on top driving day-to-day
    // returns - different frequency/phase so the two noise components are not in sync.
    const symbolBars: Bar[] = Array.from({ length: days }, (_, i) => {
      const close = 100 + i * 0.5 + Math.sin(i * 0.9) * 8;
      return { timestamp: i * 86_400_000, open: close, close, high: close * 1.01, low: close * 0.99, volume: 1_000_000 };
    });
    const spyLikeFetcher: BarsFetcher = async (symbol) => {
      if (symbol !== 'SPY') return [];
      return Array.from({ length: days }, (_, i) => {
        const close = 400 + i * 0.5 + Math.sin(i * 2.3 + 1.1) * 8; // same drift, unrelated oscillation
        return { timestamp: i * 86_400_000, open: close, close, high: close * 1.01, low: close * 0.99, volume: 1_000_000 };
      });
    };

    const result = await getMarketContext('NOISY', symbolBars, '1Day', 0, days * 86_400_000, spyLikeFetcher);

    expect(result.relativeStrengthVsSPY).not.toBeNull();
    const corr = result.relativeStrengthVsSPY!.correlation;
    expect(corr).not.toBeNull();
    // Raw price-level correlation between these two would be well above 0.9 (both dominated by
    // the identical shared linear drift). Real return-based correlation must be far lower.
    expect(Math.abs(corr as number)).toBeLessThan(0.5);
  });
});
