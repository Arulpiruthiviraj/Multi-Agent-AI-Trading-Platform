import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AlpacaBroker } from './AlpacaBroker';

/**
 * 2026-10-05 P1: Alpaca returns numeric fields as strings. A malformed qty must drop the
 * position loudly (never emit NaN); unparseable price fields map to null (unavailable).
 */
describe('AlpacaBroker.portfolio - P1 NaN-safe position mapping (2026-10-05)', () => {
  let broker: AlpacaBroker;

  beforeEach(async () => {
    broker = new AlpacaBroker();
    await broker.authenticate({ apiKey: 'test-key', secretKey: 'test-secret' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(positions: any[]) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/v2/positions')) {
        return { ok: true, json: async () => positions } as any;
      }
      if (String(url).includes('/v2/account')) {
        return { ok: true, json: async () => ({ cash: '10000', buying_power: '20000', equity: '15000' }) } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    }));
  }

  it('drops a position with unparseable quantity instead of emitting NaN', async () => {
    stubFetch([
      { symbol: 'BADQTY', qty: 'not-a-number', avg_entry_price: '100', current_price: '105', market_value: '1050', unrealized_pl: '50', unrealized_plpc: '0.05' },
      { symbol: 'GOOD', qty: '10', avg_entry_price: '100', current_price: '105', market_value: '1050', unrealized_pl: '50', unrealized_plpc: '0.05' },
    ]);

    const portfolio = await broker.portfolio();

    expect(portfolio.positions.map(p => p.symbol)).toEqual(['GOOD']);
    expect(portfolio.positions.every(p => Number.isFinite(p.quantity))).toBe(true);
  });

  it('maps unparseable price fields to null, not NaN', async () => {
    stubFetch([
      { symbol: 'BADPX', qty: '10', avg_entry_price: '', current_price: 'N/A', market_value: null, unrealized_pl: undefined, unrealized_plpc: '0.05' },
    ]);

    const portfolio = await broker.portfolio();

    expect(portfolio.positions).toHaveLength(1);
    const pos = portfolio.positions[0];
    expect(pos.entryPrice).toBeNull();
    expect(pos.currentPrice).toBeNull();
    expect(pos.marketValue).toBeNull();
    expect(pos.unrealizedPnl).toBeNull();
    // No NaN anywhere in the mapped position.
    for (const v of [pos.quantity, pos.entryPrice, pos.currentPrice, pos.marketValue, pos.unrealizedPnl, pos.unrealizedPnlPercent]) {
      expect(v === null || Number.isFinite(v)).toBe(true);
    }
  });
});
