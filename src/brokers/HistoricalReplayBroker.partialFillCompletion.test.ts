import { describe, it, expect } from 'vitest';
import { HistoricalReplayBroker } from './HistoricalReplayBroker';
import { replaySafety } from '../server/replay/replaySafety';

/**
 * Real, targeted coverage for advanceWorkingOrders() (2026-09-16, certification follow-up): the
 * multi-bar partial-fill completion mechanism this broker previously lacked entirely. A
 * PARTIALLY_FILLED order used to be permanently stuck at its first-bar quantity forever - this file
 * proves the fix directly against the real HistoricalReplayBroker class, not a mock, matching the
 * same class production/paper trading's own broker adapters exercise for a real resting order.
 */
describe('HistoricalReplayBroker.advanceWorkingOrders (multi-bar partial-fill completion)', () => {
  function makeBroker(maxVolumeParticipationPct = 0.1) {
    const broker = new HistoricalReplayBroker({
      initialCash: 1_000_000,
      costs: replaySafety.costProfiles.Base,
      timezone: 'America/New_York',
      extendedHours: false,
      shortSelling: false,
      fractional: false,
      maxVolumeParticipationPct,
    });
    broker.clockNowMs = Date.UTC(2024, 0, 2, 14, 30, 0);
    return broker;
  }

  it('a BUY capped by bar 1 volume completes over subsequent bars as more volume becomes available, converging on the correct weighted-average price', async () => {
    const broker = makeBroker(0.1);

    // Bar 1: cap = floor(1000*0.1) = 100 shares. Order for 500 -> PARTIALLY_FILLED at 100.
    broker.nextFillPrice.set('AAPL', 100);
    broker.nextFillVolume.set('AAPL', 1000);
    const order = await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 500 });
    expect(order.status).toBe('PARTIALLY_FILLED');
    expect(order.filledQuantity).toBe(100);
    expect(order.quantity).toBe(500); // originally requested, unchanged

    // Bar 2: the clock genuinely advances (as it always does in a real session), plus a new
    // price/volume - another 100-share cap fills.
    broker.clockNowMs += 60_000;
    broker.nextFillPrice.set('AAPL', 101);
    broker.nextFillVolume.set('AAPL', 1000);
    broker.advanceWorkingOrders();
    let live = (await broker.orders()).find(o => o.id === order.id)!;
    expect(live.status).toBe('PARTIALLY_FILLED');
    expect(live.filledQuantity).toBe(200);

    // Bar 3: clock advances again - a much bigger bar fills the entire remainder (300) in one advance.
    broker.clockNowMs += 60_000;
    broker.nextFillPrice.set('AAPL', 102);
    broker.nextFillVolume.set('AAPL', 10000); // cap = 1000, well above the 300 remaining
    broker.advanceWorkingOrders();
    live = (await broker.orders()).find(o => o.id === order.id)!;
    expect(live.status).toBe('FILLED');
    expect(live.filledQuantity).toBe(500);

    // Weighted-average price across the three real fills (100@~100, 100@~101, 300@~102, each plus
    // the same small configured spread/slippage applyFillPrice already adds) - computed, not assumed.
    const priced1 = broker.applyFillPrice(100).fill;
    const priced2 = broker.applyFillPrice(101).fill;
    const priced3 = broker.applyFillPrice(102).fill;
    const expectedAvg = (priced1 * 100 + priced2 * 100 + priced3 * 300) / 500;
    expect(live.averageFillPrice).toBeCloseTo(expectedAvg, 6);

    // Position reflects the full, correctly-averaged 500 shares - not just the first bar's 100.
    const portfolio = await broker.portfolio();
    const pos = portfolio.positions.find(p => p.symbol === 'AAPL')!;
    expect(pos.quantity).toBe(500);
    expect(pos.entryPrice).toBeCloseTo(expectedAvg, 6);
  });

  it('a bar with zero fresh volume/price leaves the order PARTIALLY_FILLED rather than fabricating a fill (honest "no liquidity yet")', async () => {
    const broker = makeBroker(0.1);
    broker.nextFillPrice.set('MSFT', 50);
    broker.nextFillVolume.set('MSFT', 500); // cap = 50
    const order = await broker.placeOrder({ symbol: 'MSFT', side: 'BUY', type: 'MARKET', quantity: 200 });
    expect(order.filledQuantity).toBe(50);

    // A genuine new bar (clock advances) but with no fresh price - advanceWorkingOrders() must not
    // invent one.
    broker.clockNowMs += 60_000;
    broker.nextFillPrice.delete('MSFT');
    broker.advanceWorkingOrders();
    const live = (await broker.orders()).find(o => o.id === order.id)!;
    expect(live.status).toBe('PARTIALLY_FILLED');
    expect(live.filledQuantity).toBe(50); // unchanged - no fabricated progress
  });

  it('a SELL working order stops completing once the underlying position is exhausted, rather than going negative or inventing shares', async () => {
    const broker = makeBroker(0.05);
    // Build a real 300-share position first (well within the cap, no partial fill on entry).
    broker.nextFillPrice.set('TSLA', 200);
    broker.nextFillVolume.set('TSLA', 100000);
    await broker.placeOrder({ symbol: 'TSLA', side: 'BUY', type: 'MARKET', quantity: 300 });

    // Now SELL 300, but bar 1's volume only allows a 100-share cap (0.05 * 2000).
    broker.nextFillVolume.set('TSLA', 2000);
    const sellOrder = await broker.placeOrder({ symbol: 'TSLA', side: 'SELL', type: 'MARKET', quantity: 300 });
    expect(sellOrder.status).toBe('PARTIALLY_FILLED');
    expect(sellOrder.filledQuantity).toBe(100);

    // Bar 2: clock genuinely advances; huge volume cap, but only 200 shares remain in the position -
    // must sell exactly 200, never more, and correctly reach FILLED at 300 total (100+200), not
    // stall or overshoot.
    broker.clockNowMs += 60_000;
    broker.nextFillVolume.set('TSLA', 1_000_000);
    broker.advanceWorkingOrders();
    const live = (await broker.orders()).find(o => o.id === sellOrder.id)!;
    expect(live.status).toBe('FILLED');
    expect(live.filledQuantity).toBe(300);

    const portfolio = await broker.portfolio();
    expect(portfolio.positions.find(p => p.symbol === 'TSLA')).toBeUndefined(); // fully flat
    expect(portfolio.realizedPnl).toBeDefined();
  });

  it('advanceWorkingOrders() is a safe no-op when there are no working orders (idempotent, never throws)', () => {
    const broker = makeBroker(0.1);
    expect(() => broker.advanceWorkingOrders()).not.toThrow();
    expect(() => broker.advanceWorkingOrders()).not.toThrow();
  });

  it('a duplicate advanceWorkingOrders() call for the SAME bar (clockNowMs unchanged) does not double-consume that bar\'s volume cap (2026-09-16 regression: two calls at an unchanged clock previously filled 300 shares against a 100-share single-bar cap)', async () => {
    const broker = makeBroker(0.1);
    broker.nextFillPrice.set('DUP', 100);
    broker.nextFillVolume.set('DUP', 1000); // cap = 100
    const order = await broker.placeOrder({ symbol: 'DUP', side: 'BUY', type: 'MARKET', quantity: 500 });
    expect(order.filledQuantity).toBe(100);

    // Genuine new bar (clock advances) - real progress.
    broker.clockNowMs += 60_000;
    broker.nextFillPrice.set('DUP', 101);
    broker.nextFillVolume.set('DUP', 1000);
    broker.advanceWorkingOrders();
    const afterFirst = (await broker.orders()).find(o => o.id === order.id)!;
    expect(afterFirst.filledQuantity).toBe(200);

    // A DUPLICATE of that same bar (clock unchanged since the last successful advance) - a repeat
    // market-data/tick event, or a caller advancing twice before the clock genuinely moves - must be
    // a real no-op, never a second consumption of that same bar's volume cap.
    broker.advanceWorkingOrders();
    const afterDuplicate = (await broker.orders()).find(o => o.id === order.id)!;
    expect(afterDuplicate.filledQuantity).toBe(200); // unchanged - the duplicate call consumed nothing

    // Advancing the clock to a genuine THIRD bar allows real further progress again.
    broker.clockNowMs += 60_000;
    broker.nextFillPrice.set('DUP', 102);
    broker.nextFillVolume.set('DUP', 1000);
    broker.advanceWorkingOrders();
    const afterNewBar = (await broker.orders()).find(o => o.id === order.id)!;
    expect(afterNewBar.filledQuantity).toBe(300);
  });
});
