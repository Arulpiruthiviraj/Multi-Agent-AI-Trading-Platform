import { describe, it, expect } from 'vitest';
import { InternalPaperBroker } from '../InternalPaperBroker';
import { FaultInjectingBroker, BrokerFaultInjectedError } from './FaultInjectingBroker';

describe('FaultInjectingBroker', () => {
  it('with every fault disabled, behaves identically to the wrapped broker (pure pass-through)', async () => {
    const broker = new FaultInjectingBroker(new InternalPaperBroker(), { seed: 42 });
    await broker.authenticate({ initialCash: 50_000 });
    const order = await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 10 });
    expect(order.status).toBe('PENDING');
    broker.tick({ AAPL: 100 });
    const portfolio = await broker.portfolio();
    expect(portfolio.cash).toBeLessThan(50_000);
    expect(portfolio.positions.find((p) => p.symbol === 'AAPL')?.quantity).toBe(10);
  });

  it('placeOrderRejectRate:1 rejects every order deterministically, never reaching the wrapped broker', async () => {
    const inner = new InternalPaperBroker();
    const broker = new FaultInjectingBroker(inner, { seed: 7, placeOrderRejectRate: 1 });
    await broker.authenticate({ initialCash: 10_000 });
    await expect(broker.placeOrder({ symbol: 'MSFT', side: 'BUY', type: 'MARKET', quantity: 5 }))
      .rejects.toThrow(BrokerFaultInjectedError);
    expect((await inner.orders())).toHaveLength(0); // never reached the real broker
  });

  it('the same seed reproduces the exact same sequence of reject/accept outcomes (determinism, §42)', async () => {
    async function runSequence(seed: number): Promise<boolean[]> {
      const broker = new FaultInjectingBroker(new InternalPaperBroker(), { seed, placeOrderRejectRate: 0.5 });
      await broker.authenticate({ initialCash: 1_000_000 });
      const results: boolean[] = [];
      for (let i = 0; i < 20; i++) {
        try {
          await broker.placeOrder({ symbol: 'NVDA', side: 'BUY', type: 'MARKET', quantity: 1 });
          results.push(true);
        } catch {
          results.push(false);
        }
      }
      return results;
    }
    const a = await runSequence(123);
    const b = await runSequence(123);
    expect(a).toEqual(b);
    // Sanity: rejectRate 0.5 over 20 calls should produce a genuine mix, not all-true/all-false,
    // proving the fault actually fires rather than the test accidentally always passing.
    expect(a.some((x) => x)).toBe(true);
    expect(a.some((x) => !x)).toBe(true);
  });

  it('disconnectAfterCallCount throws a simulated disconnect from that call onward, on every method', async () => {
    const broker = new FaultInjectingBroker(new InternalPaperBroker(), { seed: 1, disconnectAfterCallCount: 2 });
    await broker.authenticate({ initialCash: 1000 }); // call 1 - real
    await expect(broker.portfolio()).rejects.toThrow(BrokerFaultInjectedError); // call 2 - disconnected
    await expect(broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1 }))
      .rejects.toThrow(/disconnect/i); // call 3 - still disconnected
  });

  it('partialFillRate:1 turns every synchronously-FILLED order into a reported PARTIALLY_FILLED with a smaller filledQuantity (documented limitation: InternalPaperBroker.placeOrder() always returns PENDING - fills happen later via tick() - so this fault only fires against a broker whose placeOrder() itself returns FILLED synchronously, tested here with a minimal fake broker)', async () => {
    const syncFillBroker: any = {
      id: 'sync_fill', name: 'Sync Fill Fake',
      getCapabilities: () => ({ liveTrading: false, paperTrading: true, canPlaceOrders: true, canCancelOrders: true, usEquities: true, canadianEquities: false, crypto: false, options: false, shortSelling: false, streamingMarketData: false, requiresManualReauth: false, extendedHoursOrders: false }),
      placeOrder: async (o: any) => ({ id: 'x', symbol: o.symbol, side: o.side, type: o.type, status: 'FILLED', quantity: o.quantity, filledQuantity: o.quantity, createdAt: new Date(), updatedAt: new Date() }),
    };
    const broker = new FaultInjectingBroker(syncFillBroker, { seed: 3, partialFillRate: 1 });
    const order = await broker.placeOrder({ symbol: 'TSLA', side: 'BUY', type: 'MARKET', quantity: 100 });
    expect(order.status).toBe('PARTIALLY_FILLED');
    expect(order.filledQuantity).toBeGreaterThan(0);
    expect(order.filledQuantity).toBeLessThan(100);
  });

  it('latencyMsRange adds real, bounded, measurable delay before a call resolves', async () => {
    const broker = new FaultInjectingBroker(new InternalPaperBroker(), { seed: 1, latencyMsRange: [30, 40] });
    const start = Date.now();
    await broker.health();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(25); // small tolerance for timer granularity
  });
});
