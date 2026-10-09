/**
 * 2026-10-08 memory-leak hunt (RISK/OMS/FILLS/BROKER subsystem).
 *
 * Repro: loop N full order lifecycles through the paper brokers and observe the
 * in-memory order registries. Pre-fix these maps grow by one entry per order for
 * process lifetime - terminal (FILLED/REJECTED/CANCELED) orders were never removed.
 * Post-fix the registries are bounded: only non-terminal orders and the newest
 * terminal window are retained (terminal history remains in the trades/fills DB).
 *
 * Env flags used by the fixes under test (read per call, so tests can override):
 *   ARGUS_PAPER_BROKER_ORDER_REGISTRY_MAX - registry cap (default 5000)
 *   ARGUS_PAPER_BROKER_ORDER_EVICTION     - set 'false' to disable eviction
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InternalPaperBroker } from './InternalPaperBroker';
import { CryptoPaperBroker } from './CryptoPaperBroker';

const CAP = '100';

beforeEach(() => {
  process.env.ARGUS_PAPER_BROKER_ORDER_REGISTRY_MAX = CAP;
});
afterEach(() => {
  delete process.env.ARGUS_PAPER_BROKER_ORDER_REGISTRY_MAX;
  delete process.env.ARGUS_PAPER_BROKER_ORDER_EVICTION;
});

describe('InternalPaperBroker order registry boundedness', () => {
  it('does not retain terminal orders forever (cap bounds the registry)', async () => {
    const broker = new InternalPaperBroker();
    const cycles = 120;
    let filled = 0;
    for (let i = 0; i < cycles; i++) {
      const buy = await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1, clientOrderId: `buy-${i}` } as any);
      broker.tick({ AAPL: 100 });
      const sell = await broker.placeOrder({ symbol: 'AAPL', side: 'SELL', type: 'MARKET', quantity: 1, clientOrderId: `sell-${i}` } as any);
      broker.tick({ AAPL: 101 });
      if (buy.status === 'FILLED') filled++;
      if (sell.status === 'FILLED') filled++;
    }
    expect(filled).toBe(cycles * 2); // every order reached a terminal state
    const orders = await broker.orders();
    // Bounded: at most the configured cap may remain.
    expect(orders.length).toBeLessThanOrEqual(Number(CAP));
  });

  it('never evicts non-terminal orders, even when over cap', async () => {
    const broker = new InternalPaperBroker();
    // PENDING on a symbol we never tick, so it can never fill: eviction must spare it.
    const pending = await broker.placeOrder({ symbol: 'MSFT', side: 'BUY', type: 'MARKET', quantity: 1, clientOrderId: 'keep-me-pending' } as any);
    expect(pending.status).toBe('PENDING');
    for (let i = 0; i < 150; i++) {
      await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1 } as any);
      broker.tick({ AAPL: 100 });
    }
    const orders = await broker.orders();
    expect(orders.some((o) => o.id === pending.id && o.status === 'PENDING')).toBe(true);
    expect(orders.length).toBeLessThanOrEqual(Number(CAP));
  });
});

describe('CryptoPaperBroker order registry boundedness', () => {
  it('does not retain terminal orders forever (cap bounds the registry and index)', async () => {
    const broker = new CryptoPaperBroker(100000);
    const cycles = 120;
    for (let i = 0; i < cycles; i++) {
      await broker.placeOrder({ symbol: 'BTC-USD', side: 'BUY', type: 'MARKET', quantity: 0.001, clientOrderId: `cbuy-${i}` });
      broker.tick({ 'BTC-USD': 60000 });
      await broker.placeOrder({ symbol: 'BTC-USD', side: 'SELL', type: 'MARKET', quantity: 0.001, clientOrderId: `csell-${i}` });
      broker.tick({ 'BTC-USD': 60000 });
    }
    const orders = await broker.orders();
    expect(orders.length).toBeLessThanOrEqual(Number(CAP));
    // Non-terminal orders are never evicted: leave a PENDING order on a symbol we
    // never tick, then verify it survives the cap.
    const pending = await broker.placeOrder({ symbol: 'ETH-USD', side: 'BUY', type: 'MARKET', quantity: 0.001, clientOrderId: 'crypto-keep-pending' });
    const after = await broker.orders();
    expect(after.some((o) => o.id === pending.id)).toBe(true);
  });
});

describe('heap growth across paper order lifecycles (informational)', () => {
  it('reports retained-heap delta after 1000 full cycles', async () => {
    if (typeof (global as any).gc !== 'function') {
      console.warn('[leak-test] global.gc unavailable - run with NODE_OPTIONS=--expose-gc for heap numbers');
    }
    const broker = new InternalPaperBroker();
    const gc = (global as any).gc as (() => void) | undefined;
    const heapMb = () => process.memoryUsage().heapUsed / 1024 / 1024;
    gc?.(); gc?.();
    const before = heapMb();
    for (let i = 0; i < 1000; i++) {
      await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1 } as any);
      broker.tick({ AAPL: 100 });
    }
    gc?.(); gc?.();
    const after = heapMb();
    const registrySize = (await broker.orders()).length;
    console.log(`[leak-test] cycles=1000 registrySize=${registrySize} heapBefore=${before.toFixed(1)}MB heapAfter=${after.toFixed(1)}MB delta=${(after - before).toFixed(1)}MB`);
  });
});
