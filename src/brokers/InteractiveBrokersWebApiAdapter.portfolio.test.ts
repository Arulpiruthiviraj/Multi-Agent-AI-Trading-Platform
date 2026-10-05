import { describe, it, expect, vi } from 'vitest';
import { InteractiveBrokersWebApiAdapter } from './InteractiveBrokersWebApiAdapter';

/**
 * 2026-10-05 P1: the IBKR Web API omits avgCost/mktPrice for some positions. Missing
 * basis/mark/value must map to null (genuinely unavailable, per F26) with
 * valuationStatus UNAVAILABLE — never a fabricated 0, which both tripped
 * CAPITAL_SNAPSHOT_DEGRADED permanently and fed PortfolioMonitor's div-by-zero.
 */
describe('InteractiveBrokersWebApiAdapter.portfolio - P1 null (not 0) valuation (2026-10-05)', () => {
  it('maps missing avgCost/mktPrice/mktValue to null with UNAVAILABLE status', async () => {
    const adapter = new InteractiveBrokersWebApiAdapter();
    vi.spyOn(adapter as any, 'request').mockImplementation(async (path: string) => {
      if (path === '/portfolio/accounts') return [{ id: 'TEST123' }] as any;
      if (path.includes('/summary')) {
        return { totalcashvalue: { amount: 10000 }, netliquidation: { amount: 15000 } } as any;
      }
      if (path.includes('/positions/')) {
        return [
          // Position with NO avgCost, NO mktPrice, NO mktValue — old code fabricated 0s.
          { contractDesc: 'NOBASIS', position: 10 },
          // Position with full data — control.
          { contractDesc: 'FULL', position: 5, avgCost: 100, mktPrice: 110, mktValue: 550, unrealizedPnl: 50 },
        ] as any;
      }
      return {} as any;
    });

    const portfolio = await adapter.portfolio();
    const noBasis = portfolio.positions.find(p => p.symbol === 'NOBASIS')!;
    const full = portfolio.positions.find(p => p.symbol === 'FULL')!;

    // Missing fields → null, never 0.
    expect(noBasis.entryPrice).toBeNull();
    expect(noBasis.currentPrice).toBeNull();
    expect(noBasis.marketValue).toBeNull();
    expect(noBasis.unrealizedPnl).toBeNull();
    expect(noBasis.valuationStatus).toBe('UNAVAILABLE');

    // Full data → real values, no UNAVAILABLE flag.
    expect(full.entryPrice).toBe(100);
    expect(full.currentPrice).toBe(110);
    expect(full.marketValue).toBe(550);
    expect(full.valuationStatus).not.toBe('UNAVAILABLE');
  });
});
