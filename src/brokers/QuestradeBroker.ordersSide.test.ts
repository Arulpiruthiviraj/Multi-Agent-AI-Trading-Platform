import { describe, it, expect, vi, afterEach } from 'vitest';
import { QuestradeBroker } from './QuestradeBroker';

/**
 * 2026-10-10 cross-cutting defect hunt (worker 2 needs-decision item 6a, adjudicated):
 * QuestradeBroker.orders() used
 *   side: (o.side ?? '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY'
 * Questrade's documented order sides are Buy/Sell/Short/Cov/BTO/STC/STO/BTC
 * ("client view of the order side", e.g. "Buy-To-Open"). The old pattern mislabeled
 * every sell-family side except literal "Sell" - STC (Sell-To-Close), STO
 * (Sell-To-Open) and Short all became BUY - and fabricated BUY for a missing side.
 * A mislabeled side corrupts OMS follow-up, the reconciliation orphan scan, and the
 * orchestration snapshot. Fix: mapQuestradeOrderSide() maps the documented values
 * and returns null for missing/unrecognized sides; orders() skips those rows loudly
 * (sanctioned per-row skip pattern, same as AlpacaBroker 1856513), never fabricating.
 */
function brokerWithOrders(rows: any[]): QuestradeBroker {
  const broker = new QuestradeBroker();
  (broker as any).accountNumber = '12345678';
  vi.spyOn(broker as any, 'fetchQuestrade').mockResolvedValue({ orders: rows });
  return broker;
}

const baseRow = {
  id: 1,
  symbol: 'TD.TO',
  orderType: 'Limit',
  state: 'Executed',
  totalQuantity: 100,
  filledQuantity: 100,
  limitPrice: 90,
  creationTime: '2026-10-10T10:00:00Z',
  updateTime: '2026-10-10T10:01:00Z',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('QuestradeBroker.orders() side mapping', () => {
  it.each([
    ['Buy', 'BUY'],
    ['Sell', 'SELL'],
    ['BTO', 'BUY'],
    ['BTC', 'BUY'],
    ['Cov', 'BUY'],
    ['STC', 'SELL'],
    ['STO', 'SELL'],
    ['Short', 'SELL'],
    ['buy', 'BUY'], // case-insensitive, as the API documents mixed case
    ['sell', 'SELL'],
  ])('maps documented Questrade side %s to %s', async (apiSide, expected) => {
    const broker = brokerWithOrders([{ ...baseRow, side: apiSide }]);
    const orders = await broker.orders();
    expect(orders).toHaveLength(1);
    expect(orders[0].side).toBe(expected);
  });

  it('skips a row with a missing side loudly instead of fabricating BUY', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broker = brokerWithOrders([
      { ...baseRow, id: 1, side: 'Buy' },
      { ...baseRow, id: 2, side: undefined },
      { ...baseRow, id: 3, side: 'STC' },
    ]);
    const orders = await broker.orders();
    expect(orders.map((o) => o.id)).toEqual(['1', '3']);
    expect(orders[1].side).toBe('SELL'); // STC is sell-to-close, not BUY
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('id=2'));
    warn.mockRestore();
  });

  it('skips a row with an unrecognized side value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broker = brokerWithOrders([{ ...baseRow, side: 'SIDEWAYS' }]);
    expect(await broker.orders()).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not let one bad row kill the whole order list', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broker = brokerWithOrders([
      { ...baseRow, id: 1, side: 'Buy' },
      { ...baseRow, id: 2 }, // no side at all
      { ...baseRow, id: 3, side: 'Sell' },
    ]);
    const orders = await broker.orders();
    expect(orders).toHaveLength(2);
    expect(orders.map((o) => o.side)).toEqual(['BUY', 'SELL']);
  });
});
