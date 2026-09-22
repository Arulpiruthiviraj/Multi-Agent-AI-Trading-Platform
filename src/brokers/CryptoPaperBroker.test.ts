import { describe, it, expect, beforeEach } from 'vitest';
import { CryptoPaperBroker } from './CryptoPaperBroker';

describe('CryptoPaperBroker', () => {
  let broker: CryptoPaperBroker;

  beforeEach(() => {
    broker = new CryptoPaperBroker(100000);
  });

  it('reports crypto capability, no live trading, no shorting', () => {
    const caps = broker.getCapabilities();
    expect(caps.crypto).toBe(true);
    expect(caps.liveTrading).toBe(false);
    expect(caps.shortSelling).toBe(false);
    expect(caps.paperTrading).toBe(true);
  });

  it('liveTrading() throws - structurally refuses to arm live', () => {
    expect(() => broker.liveTrading()).toThrow(/PAPER-only/);
  });

  it('rejects an order for an unregistered symbol rather than silently accepting it', async () => {
    const order = await broker.placeOrder({ symbol: 'DOGE-USD', side: 'BUY', quantity: 1, type: 'MARKET' });
    expect(order.status).toBe('REJECTED');
  });

  it('rejects a non-positive quantity', async () => {
    const order = await broker.placeOrder({ symbol: 'BTC-USD', side: 'BUY', quantity: 0, type: 'MARKET' });
    expect(order.status).toBe('REJECTED');
  });

  it('rejects a SELL that exceeds the held quantity - long-only, no shorting', async () => {
    const order = await broker.placeOrder({ symbol: 'BTC-USD', side: 'SELL', quantity: 0.01, type: 'MARKET' });
    expect(order.status).toBe('REJECTED');
  });

  it('accepts a valid BTC-USD BUY as PENDING', async () => {
    const order = await broker.placeOrder({ symbol: 'btc-usd', side: 'BUY', quantity: 0.05, type: 'MARKET' });
    expect(order.status).toBe('PENDING');
    expect(order.symbol).toBe('BTC-USD'); // canonicalized
  });

  it('clientOrderId idempotency: a second placeOrder with the same id returns the existing order, never a duplicate', async () => {
    const first = await broker.placeOrder({ clientOrderId: 'abc-123', symbol: 'BTC-USD', side: 'BUY', quantity: 0.05, type: 'MARKET' });
    const second = await broker.placeOrder({ clientOrderId: 'abc-123', symbol: 'BTC-USD', side: 'BUY', quantity: 0.05, type: 'MARKET' });
    expect(second.id).toBe(first.id);
    const all = await broker.orders();
    expect(all.length).toBe(1);
  });

  it('fills a MARKET BUY on tick(), applying spread/slippage/fee (fill price != raw tick price)', async () => {
    const order = await broker.placeOrder({ symbol: 'BTC-USD', side: 'BUY', quantity: 0.1, type: 'MARKET' });
    broker.tick({ 'BTC-USD': 60000 });
    const [filled] = (await broker.orders()).filter(o => o.id === order.id);
    expect(filled.status).toBe('FILLED');
    expect(filled.averageFillPrice).toBeGreaterThan(60000); // BUY pays spread+slippage above raw price
    const positions = await broker.positions();
    expect(positions.length).toBe(1);
    expect(positions[0].quantity).toBeCloseTo(0.1, 10);
  });

  it('never uses the magical exact signal price for a fill - fee/spread/slippage always apply', async () => {
    await broker.placeOrder({ symbol: 'ETH-USD', side: 'BUY', quantity: 1, type: 'MARKET' });
    broker.tick({ 'ETH-USD': 2500 });
    const positions = await broker.positions();
    expect(positions[0].entryPrice).not.toBe(2500);
  });

  it('rejects a BUY at fill time when cash is insufficient', async () => {
    const poorBroker = new CryptoPaperBroker(10); // $10 cash
    const order = await poorBroker.placeOrder({ symbol: 'BTC-USD', side: 'BUY', quantity: 1, type: 'MARKET' });
    poorBroker.tick({ 'BTC-USD': 60000 });
    const [result] = (await poorBroker.orders()).filter(o => o.id === order.id);
    expect(result.status).toBe('REJECTED');
  });

  it('partial fill: an order whose notional exceeds maxFillNotionalPerTick fills across multiple ticks', async () => {
    // Real config default maxFillNotionalPerTick=50000. A 2 BTC order at 60000 = 120000 notional,
    // well above the per-tick cap - must partially fill, not fill (or reject) all at once. Ample
    // cash so this specifically isolates the partial-fill mechanism from the separate
    // insufficient-cash-rejection behavior (covered by its own test above).
    const richBroker = new CryptoPaperBroker(500000);
    const order = await richBroker.placeOrder({ symbol: 'BTC-USD', side: 'BUY', quantity: 2, type: 'MARKET' });
    richBroker.tick({ 'BTC-USD': 60000 });
    const [afterFirstTick] = (await richBroker.orders()).filter(o => o.id === order.id);
    expect(afterFirstTick.status).toBe('PARTIALLY_FILLED');
    expect(afterFirstTick.filledQuantity).toBeGreaterThan(0);
    expect(afterFirstTick.filledQuantity).toBeLessThan(2);

    // Keep ticking until fully filled (bounded loop, never infinite).
    let ticks = 0;
    let latest = afterFirstTick;
    while (latest.status !== 'FILLED' && ticks < 20) {
      richBroker.tick({ 'BTC-USD': 60000 });
      [latest] = (await richBroker.orders()).filter(o => o.id === order.id);
      ticks++;
    }
    expect(latest.status).toBe('FILLED');
    expect(latest.filledQuantity).toBeCloseTo(2, 6);
  });

  it('tracks realized P&L on a profitable SELL and reflects it in portfolio()', async () => {
    const buy = await broker.placeOrder({ symbol: 'BTC-USD', side: 'BUY', quantity: 0.1, type: 'MARKET' });
    broker.tick({ 'BTC-USD': 60000 });
    let [filledBuy] = (await broker.orders()).filter(o => o.id === buy.id);
    expect(filledBuy.status).toBe('FILLED');

    const sell = await broker.placeOrder({ symbol: 'BTC-USD', side: 'SELL', quantity: 0.1, type: 'MARKET' });
    broker.tick({ 'BTC-USD': 65000 }); // price rose
    const [filledSell] = (await broker.orders()).filter(o => o.id === sell.id);
    expect(filledSell.status).toBe('FILLED');

    const portfolio = await broker.portfolio();
    expect(portfolio.realizedPnl).toBeGreaterThan(0);
    expect(portfolio.positions.length).toBe(0); // fully closed
  });

  it('fractional quantities are preserved exactly through the full order lifecycle (no integer coercion anywhere)', async () => {
    const order = await broker.placeOrder({ symbol: 'ETH-USD', side: 'BUY', quantity: 0.004217, type: 'MARKET' });
    broker.tick({ 'ETH-USD': 2500 });
    const positions = await broker.positions();
    expect(positions[0].quantity).toBeCloseTo(0.004217, 9);
  });

  it('cancelOrder() cancels a PENDING order and it no longer fills on a later tick', async () => {
    const order = await broker.placeOrder({ symbol: 'BTC-USD', side: 'BUY', quantity: 0.01, type: 'MARKET' });
    const cancelled = await broker.cancelOrder(order.id);
    expect(cancelled).toBe(true);
    broker.tick({ 'BTC-USD': 60000 });
    const [result] = (await broker.orders()).filter(o => o.id === order.id);
    expect(result.status).toBe('CANCELED');
    expect((await broker.positions()).length).toBe(0);
  });

  it('getOrderByClientOrderId() finds an order placed with a clientOrderId', async () => {
    const placed = await broker.placeOrder({ clientOrderId: 'lookup-me', symbol: 'BTC-USD', side: 'BUY', quantity: 0.01, type: 'MARKET' });
    const found = await broker.getOrderByClientOrderId!('lookup-me');
    expect(found?.id).toBe(placed.id);
  });

  it('closePosition() sells the full held quantity', async () => {
    await broker.placeOrder({ symbol: 'BTC-USD', side: 'BUY', quantity: 0.05, type: 'MARKET' });
    broker.tick({ 'BTC-USD': 60000 });
    const closed = await broker.closePosition('BTC-USD');
    expect(closed).toBe(true);
    broker.tick({ 'BTC-USD': 60000 });
    expect((await broker.positions()).length).toBe(0);
  });
});
