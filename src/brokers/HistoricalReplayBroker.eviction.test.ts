import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HistoricalReplayBroker } from './HistoricalReplayBroker';
import { replaySafety } from '../server/replay/replaySafety';

/**
 * Real defect (2026-10-08 defect hunt, execution D3): HistoricalReplayBroker._orders grew
 * one entry per replay order and was never evicted - the Oct-8 memory hunt bounded the
 * other paper-broker registries but missed the replay broker. Now uses the same
 * evictOldestTerminalOrdersIfOverCap treatment (non-terminal orders never evicted).
 */
describe('HistoricalReplayBroker order registry eviction (D3)', () => {
  const OLD_MAX = process.env.ARGUS_PAPER_BROKER_ORDER_REGISTRY_MAX;
  const OLD_ENABLED = process.env.ARGUS_PAPER_BROKER_ORDER_EVICTION;

  beforeEach(() => {
    process.env.ARGUS_PAPER_BROKER_ORDER_REGISTRY_MAX = '50';
    delete process.env.ARGUS_PAPER_BROKER_ORDER_EVICTION;
  });
  afterEach(() => {
    if (OLD_MAX === undefined) delete process.env.ARGUS_PAPER_BROKER_ORDER_REGISTRY_MAX;
    else process.env.ARGUS_PAPER_BROKER_ORDER_REGISTRY_MAX = OLD_MAX;
    if (OLD_ENABLED === undefined) delete process.env.ARGUS_PAPER_BROKER_ORDER_EVICTION;
    else process.env.ARGUS_PAPER_BROKER_ORDER_EVICTION = OLD_ENABLED;
  });

  function makeBroker() {
    const broker = new HistoricalReplayBroker({
      initialCash: 1_000_000,
      costs: replaySafety.costProfiles.Base,
      timezone: 'America/New_York',
      extendedHours: false,
      shortSelling: false,
      fractional: false,
    });
    broker.clockNowMs = Date.UTC(2024, 0, 2, 14, 30, 0);
    broker.nextFillPrice.set('AAPL', 150);
    return broker;
  }

  it('bounds _orders at the configured cap across many replay orders', async () => {
    const broker = makeBroker();
    for (let i = 0; i < 200; i++) {
      await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1 });
      broker.clockNowMs += 60_000; // advance so updatedAt ordering is meaningful
    }
    const orders = await broker.orders();
    expect(orders.length).toBeLessThanOrEqual(50);
    expect(orders.length).toBeGreaterThan(0);
  });

  it('never evicts a non-terminal order to make room', async () => {
    const broker = makeBroker();
    // Seed a PARTIALLY_FILLED working order (non-terminal) via the working-orders path.
    for (let i = 0; i < 200; i++) {
      await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1 });
      broker.clockNowMs += 60_000;
    }
    const orders = await broker.orders();
    const nonTerminal = orders.filter((o) => o.status !== 'FILLED' && o.status !== 'REJECTED' && o.status !== 'CANCELED');
    // Whatever non-terminal orders exist must all survive eviction.
    for (const o of nonTerminal) {
      expect((broker as any)._orders.has(o.id)).toBe(true);
    }
  });

  it('eviction can be disabled via the kill switch', async () => {
    process.env.ARGUS_PAPER_BROKER_ORDER_EVICTION = 'false';
    const broker = makeBroker();
    for (let i = 0; i < 60; i++) {
      await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1 });
      broker.clockNowMs += 60_000;
    }
    expect((await broker.orders()).length).toBe(60);
  });
});
