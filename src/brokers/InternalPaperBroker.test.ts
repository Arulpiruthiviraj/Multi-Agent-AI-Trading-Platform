import { describe, it, expect } from 'vitest';
import { InternalPaperBroker } from './InternalPaperBroker';

describe('InternalPaperBroker P1 (2026-10-05)', () => {
  it('preserves clientOrderId and resolves via getOrderByClientOrderId', async () => {
    const broker = new InternalPaperBroker();
    const order = await broker.placeOrder({
      symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 10, clientOrderId: 'oms-row-123',
    } as any);
    expect(order.clientOrderId).toBe('oms-row-123');
    const found = await broker.getOrderByClientOrderId('oms-row-123');
    expect(found?.id).toBe(order.id);
    expect(await broker.getOrderByClientOrderId('nope')).toBeNull();
  });

  it('rejects an over-sell without minting cash (position coverage checked BEFORE credit)', async () => {
    const broker = new InternalPaperBroker();
    const cashBefore = await broker.getBuyingPower();
    // No position at all: SELL must be REJECTED, cash untouched.
    const sell = await broker.placeOrder({ symbol: 'AAPL', side: 'SELL', type: 'MARKET', quantity: 5 } as any);
    broker.tick({ AAPL: 100 });
    expect(sell.status).toBe('REJECTED');
    expect(await broker.getBuyingPower()).toBe(cashBefore);
    expect(await broker.positions()).toHaveLength(0);
  });

  it('rejects a SELL larger than the held position', async () => {
    const broker = new InternalPaperBroker();
    const buy = await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 3 } as any);
    broker.tick({ AAPL: 100 });
    expect(buy.status).toBe('FILLED');
    const cashAfterBuy = await broker.getBuyingPower();
    const sell = await broker.placeOrder({ symbol: 'AAPL', side: 'SELL', type: 'MARKET', quantity: 10 } as any);
    broker.tick({ AAPL: 100 });
    expect(sell.status).toBe('REJECTED');
    expect(await broker.getBuyingPower()).toBe(cashAfterBuy);
    // Position untouched.
    expect((await broker.positions())[0]?.quantity).toBe(3);
  });

  it('still fills a SELL fully covered by the position', async () => {
    const broker = new InternalPaperBroker();
    await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 5 } as any);
    broker.tick({ AAPL: 100 });
    const sell = await broker.placeOrder({ symbol: 'AAPL', side: 'SELL', type: 'MARKET', quantity: 5 } as any);
    broker.tick({ AAPL: 100 });
    expect(sell.status).toBe('FILLED');
    expect(await broker.positions()).toHaveLength(0);
  });
});
