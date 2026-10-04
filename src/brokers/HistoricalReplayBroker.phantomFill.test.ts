import { describe, it, expect } from 'vitest';
import { HistoricalReplayBroker } from './HistoricalReplayBroker';
import { replaySafety } from '../server/replay/replaySafety';

/**
 * P1-16 (2026-10-04 remediation). placeOrder()'s SELL branch computed
 * sellQty = Math.min(qty, existing?.quantity ?? 0) for cash/P&L/position (correctly clamped to the
 * held long), but the returned Order object still reported filledQuantity = the pre-clamp qty - a
 * phantom fill where the ledger claimed more shares sold than the broker's own economics reflect.
 * This broker has no negative-inventory/short-position model anywhere, so a SELL that exceeds the
 * held long (with shortSelling: true, which only gates whether the oversell is rejected outright)
 * must report only the quantity it actually processed.
 */
describe('HistoricalReplayBroker phantom-fill fix (position-insufficient SELL)', () => {
  function makeBroker(shortSelling: boolean) {
    const broker = new HistoricalReplayBroker({
      initialCash: 1_000_000,
      costs: replaySafety.costProfiles.Base,
      timezone: 'America/New_York',
      extendedHours: false,
      shortSelling,
      fractional: false,
    });
    broker.clockNowMs = Date.UTC(2024, 0, 2, 14, 30, 0);
    return broker;
  }

  it('reports a REJECTED zero-fill (never a phantom full fill) selling with no position at all, even when shortSelling is enabled', async () => {
    const broker = makeBroker(true);
    broker.nextFillPrice.set('AAPL', 150);
    const order = await broker.placeOrder({ symbol: 'AAPL', side: 'SELL', type: 'MARKET', quantity: 10 });
    expect(order.filledQuantity).toBe(0);
    expect(order.status).toBe('REJECTED');
    expect(order.quantity).toBe(10); // originally requested, unchanged
    expect((await broker.positions())).toEqual([]);
    const portfolio = await broker.portfolio();
    expect(portfolio.cash).toBe(1_000_000); // untouched - no phantom proceeds credited
  });

  it('reports a truthful PARTIALLY_FILLED capped at the held quantity, never the full requested amount, when shortSelling is enabled', async () => {
    const broker = makeBroker(true);
    broker.nextFillPrice.set('AAPL', 100);
    await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 5 });

    broker.nextFillPrice.set('AAPL', 110);
    const order = await broker.placeOrder({ symbol: 'AAPL', side: 'SELL', type: 'MARKET', quantity: 14 });

    expect(order.filledQuantity).toBe(5); // only the held long, never 14
    expect(order.quantity).toBe(14); // originally requested, reported honestly
    expect(order.status).toBe('PARTIALLY_FILLED');
    // No short position was fabricated for the uncovered remainder.
    expect((await broker.positions())).toEqual([]);
  });

  it('never registers the position-insufficient remainder as a working order (no short-position model exists for it to ever complete against)', async () => {
    const broker = makeBroker(true);
    broker.nextFillPrice.set('AAPL', 100);
    await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 5 });
    broker.nextFillPrice.set('AAPL', 110);
    const order = await broker.placeOrder({ symbol: 'AAPL', side: 'SELL', type: 'MARKET', quantity: 14 });
    expect(order.status).toBe('PARTIALLY_FILLED');

    broker.clockNowMs += 60_000;
    broker.advanceWorkingOrders();
    const after = (await broker.orders()).find(o => o.id === order.id)!;
    expect(after.filledQuantity).toBe(5); // unchanged - never silently "completes" the phantom remainder
  });

  it('charges commission only on the quantity actually sold, not the originally requested quantity', async () => {
    const broker = makeBroker(true);
    broker.nextFillPrice.set('AAPL', 100);
    await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 5 });
    const cashAfterBuy = (await broker.portfolio()).cash;

    broker.nextFillPrice.set('AAPL', 110);
    const order = await broker.placeOrder({ symbol: 'AAPL', side: 'SELL', type: 'MARKET', quantity: 14 });
    const cashAfterSell = (await broker.portfolio()).cash;

    const commissionPerShare = replaySafety.costProfiles.Base.commissionPerShare;
    const expectedProceeds = order.averageFillPrice! * 5;
    const expectedCommission = commissionPerShare * 5; // 5, not 14
    expect(cashAfterSell).toBeCloseTo(cashAfterBuy + expectedProceeds - expectedCommission, 5);
  });

  it('still rejects outright with filledQuantity 0 when shortSelling is disabled (unchanged pre-existing behavior)', async () => {
    const broker = makeBroker(false);
    broker.nextFillPrice.set('AAPL', 100);
    await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 5 });
    broker.nextFillPrice.set('AAPL', 110);
    const order = await broker.placeOrder({ symbol: 'AAPL', side: 'SELL', type: 'MARKET', quantity: 14 });
    expect(order.status).toBe('REJECTED');
    expect(order.filledQuantity).toBe(0);
  });

  it('a normal, fully-covered SELL is completely unaffected (same filledQuantity/status/commission as before)', async () => {
    const broker = makeBroker(true);
    broker.nextFillPrice.set('AAPL', 100);
    await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 10 });
    broker.nextFillPrice.set('AAPL', 110);
    const order = await broker.placeOrder({ symbol: 'AAPL', side: 'SELL', type: 'MARKET', quantity: 10 });
    expect(order.filledQuantity).toBe(10);
    expect(order.status).toBe('FILLED');
    expect((await broker.positions())).toEqual([]);
  });
});
