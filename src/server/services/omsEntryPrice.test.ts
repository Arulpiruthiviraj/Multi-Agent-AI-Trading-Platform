import { describe, it, expect, vi, beforeEach } from 'vitest';

const { nextSelectRows, setSelectQueue } = vi.hoisted(() => {
  let queue: any[][] = [];
  return {
    nextSelectRows: () => (queue.length > 0 ? queue.shift()! : []),
    setSelectQueue: (rows: any[][]) => { queue = rows.map((r) => [...r]); },
  };
});

vi.mock('../db', () => ({
  db: {
    select: () => {
      const chain: any = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve(nextSelectRows()),
        then: (resolve: any, reject: any) => Promise.resolve(nextSelectRows()).then(resolve, reject),
      };
      return chain;
    },
  },
}));

vi.mock('../replay/replaySafety', () => ({
  replaySafety: { replayTracePrefix: 'replay-' },
}));

import { resolvePreTradeEntryPrice } from './omsEntryPrice';

describe('resolvePreTradeEntryPrice', () => {
  beforeEach(() => {
    setSelectQueue([]);
  });

  it('uses broker position entryPrice when present', async () => {
    const price = await resolvePreTradeEntryPrice('AAPL', async () => [
      { symbol: 'AAPL', entryPrice: 100 },
    ]);
    expect(price).toBe(100);
  });

  it('falls back to local portfolio.averagePrice when broker positions() throws', async () => {
    setSelectQueue([[{ symbol: 'NVDA', averagePrice: 206.85, quantity: 1 }]]);
    const price = await resolvePreTradeEntryPrice('NVDA', async () => {
      throw new Error('broker portfolio unavailable');
    });
    expect(price).toBe(206.85);
  });

  it('falls back to opening FILLED BUY trade price when broker misses symbol and portfolio empty', async () => {
    setSelectQueue([
      [], // portfolio miss
      [{
        symbol: 'NVDA',
        side: 'BUY',
        status: 'FILLED',
        price: 210,
        executionEnvironment: 'PAPER',
        filledAt: '2026-08-20T16:00:00.000Z',
        traceId: 'live-trace-1',
      }],
    ]);
    const price = await resolvePreTradeEntryPrice('NVDA', async () => []);
    expect(price).toBe(210);
  });

  it('ignores REPLAY opening trades when falling back to trades cost basis', async () => {
    setSelectQueue([
      [],
      [{
        symbol: 'NVDA',
        side: 'BUY',
        status: 'FILLED',
        price: 114.22,
        executionEnvironment: 'REPLAY',
        filledAt: '2026-08-20T16:00:00.000Z',
        traceId: 'replay-xyz',
      }],
    ]);
    const price = await resolvePreTradeEntryPrice('NVDA', async () => []);
    expect(price).toBeNull();
  });

  it('returns null when broker, portfolio, and trades all lack a usable price', async () => {
    setSelectQueue([[], []]);
    const price = await resolvePreTradeEntryPrice('ZZZ', async () => {
      throw new Error('down');
    });
    expect(price).toBeNull();
  });
});
