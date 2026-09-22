import { describe, it, expect } from 'vitest';
import { SyntheticCryptoBroker } from './SyntheticCryptoBroker';
import { generateOrderBookSnapshot } from './SyntheticOrderBook';
import { SyntheticRandom } from '../../replay/synthetic/SyntheticRandom';

describe('SyntheticCryptoBroker', () => {
  it('refuses a non-synthetic symbol via the production-pollution guard', () => {
    const broker = new SyntheticCryptoBroker(1);
    expect(() =>
      broker.submit({ clientOrderId: 'a', symbol: 'AAPL', side: 'BUY', quantity: 1, arrivalPrice: 100 }, 0),
    ).toThrow(/PRODUCTION_POLLUTION_GUARD/);
  });

  it('acknowledges a fresh order while connected', () => {
    const broker = new SyntheticCryptoBroker(1);
    const order = broker.submit({ clientOrderId: 'a', symbol: 'SYNTEST001', side: 'BUY', quantity: 1, arrivalPrice: 100 }, 0);
    expect(order.status).toBe('ACKNOWLEDGED');
  });

  it('idempotency: submitting the same clientOrderId twice returns the identical record, never a second order', () => {
    const broker = new SyntheticCryptoBroker(1);
    const first = broker.submit({ clientOrderId: 'dup', symbol: 'SYNTEST001', side: 'BUY', quantity: 5, arrivalPrice: 100 }, 0);
    const second = broker.submit({ clientOrderId: 'dup', symbol: 'SYNTEST001', side: 'BUY', quantity: 999, arrivalPrice: 500 }, 100);
    expect(second).toBe(first); // same object reference - not even a new copy
    expect(broker.allOrders()).toHaveLength(1);
  });

  it('a disconnected broker produces UNKNOWN status rather than a false rejection or false acknowledgement', () => {
    const broker = new SyntheticCryptoBroker(1);
    broker.simulateDisconnect();
    const order = broker.submit({ clientOrderId: 'a', symbol: 'SYNTEST001', side: 'BUY', quantity: 1, arrivalPrice: 100 }, 0);
    expect(order.status).toBe('UNKNOWN');
  });

  it('reconnecting allows subsequent NEW orders to acknowledge normally', () => {
    const broker = new SyntheticCryptoBroker(1);
    broker.simulateDisconnect();
    broker.submit({ clientOrderId: 'a', symbol: 'SYNTEST001', side: 'BUY', quantity: 1, arrivalPrice: 100 }, 0);
    broker.simulateReconnect();
    const order = broker.submit({ clientOrderId: 'b', symbol: 'SYNTEST001', side: 'BUY', quantity: 1, arrivalPrice: 100 }, 1);
    expect(order.status).toBe('ACKNOWLEDGED');
  });

  it('applyFill on a terminal order is a no-op (cannot advance a filled order twice)', () => {
    const broker = new SyntheticCryptoBroker(1);
    broker.submit({ clientOrderId: 'a', symbol: 'SYNTEST001', side: 'BUY', quantity: 1, arrivalPrice: 100 }, 0);
    const book = generateOrderBookSnapshot(new SyntheticRandom(1), 100, 'LARGE_CAP', 0.3);
    // Drive the order to a terminal state with enough attempts under favorable (low-vol, large-cap) conditions.
    let order = broker.getOrder('a')!;
    for (let i = 0; i < 20 && order.status !== 'FILLED' && order.status !== 'REJECTED'; i++) {
      order = broker.applyFill('a', book, 'LARGE_CAP', 0.3, i);
    }
    expect(['FILLED', 'REJECTED']).toContain(order.status);
    const filledSnapshot = { ...order, fills: [...order.fills] };
    const again = broker.applyFill('a', book, 'LARGE_CAP', 0.3, 999);
    expect(again.status).toBe(filledSnapshot.status);
    expect(again.filledQuantity).toBe(filledSnapshot.filledQuantity);
    expect(again.fills).toHaveLength(filledSnapshot.fills.length);
  });

  it('cancelling a terminal order returns CANCEL_REJECTED rather than silently succeeding', () => {
    const broker = new SyntheticCryptoBroker(1);
    broker.submit({ clientOrderId: 'a', symbol: 'SYNTEST001', side: 'BUY', quantity: 1, arrivalPrice: 100 }, 0);
    const book = generateOrderBookSnapshot(new SyntheticRandom(1), 100, 'LARGE_CAP', 0.3);
    let order = broker.getOrder('a')!;
    for (let i = 0; i < 20 && order.status !== 'FILLED' && order.status !== 'REJECTED'; i++) {
      order = broker.applyFill('a', book, 'LARGE_CAP', 0.3, i);
    }
    const cancelResult = broker.cancel('a', 999);
    expect(cancelResult.status).toBe('CANCEL_REJECTED');
  });

  it('cancelling a live (acknowledged) order succeeds', () => {
    const broker = new SyntheticCryptoBroker(1);
    broker.submit({ clientOrderId: 'a', symbol: 'SYNTEST001', side: 'BUY', quantity: 1, arrivalPrice: 100 }, 0);
    const cancelled = broker.cancel('a', 1);
    expect(cancelled.status).toBe('CANCELLED');
  });

  it('throws for operations against an unknown clientOrderId', () => {
    const broker = new SyntheticCryptoBroker(1);
    const book = generateOrderBookSnapshot(new SyntheticRandom(1), 100, 'MID_CAP', 1.0);
    expect(() => broker.applyFill('nope', book, 'MID_CAP', 1.0, 0)).toThrow();
    expect(() => broker.cancel('nope', 0)).toThrow();
  });
});
