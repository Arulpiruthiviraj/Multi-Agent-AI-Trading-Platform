/**
 * 2026-10-08 memory-leak hunt (RISK/OMS/FILLS/BROKER): regression tests for the bounded
 * in-memory hygiene helpers used by the paper brokers and OMS warn-once registries.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BoundedWarnOnce,
  evictOldestTerminalOrdersIfOverCap,
  isTerminalBrokerOrderStatus,
  resolvePaperBrokerOrderRegistryMax,
  resolveOmsWarnOnceMax,
  DEFAULT_PAPER_BROKER_ORDER_REGISTRY_MAX_ENTRIES,
  DEFAULT_OMS_WARN_ONCE_MAX_ENTRIES,
  type Order,
} from './brokerMemory';

describe('isTerminalBrokerOrderStatus', () => {
  it('classifies paper-broker terminal statuses only', () => {
    expect(isTerminalBrokerOrderStatus('FILLED')).toBe(true);
    expect(isTerminalBrokerOrderStatus('CANCELED')).toBe(true);
    expect(isTerminalBrokerOrderStatus('REJECTED')).toBe(true);
    expect(isTerminalBrokerOrderStatus('PENDING')).toBe(false);
    expect(isTerminalBrokerOrderStatus('PARTIALLY_FILLED')).toBe(false);
    expect(isTerminalBrokerOrderStatus(null)).toBe(false);
  });
});

describe('evictOldestTerminalOrdersIfOverCap', () => {
  const order = (id: string, status: string, ageMs: number): Order =>
    ({ id, status, updatedAt: new Date(Date.now() - ageMs) }) as Order;

  it('is a no-op at or under the cap', () => {
    const m = new Map([['a', order('a', 'FILLED', 1000)], ['b', order('b', 'FILLED', 2000)]]);
    expect(evictOldestTerminalOrdersIfOverCap(m, 2)).toBe(0);
    expect(m.size).toBe(2);
  });

  it('evicts oldest terminal first, never non-terminal, until at cap', () => {
    const m = new Map<string, Order>([
      ['old-fill', order('old-fill', 'FILLED', 9000)],
      ['mid-cancel', order('mid-cancel', 'CANCELED', 5000)],
      ['new-reject', order('new-reject', 'REJECTED', 1000)],
      ['pending', order('pending', 'PENDING', 8000)],
      ['partial', order('partial', 'PARTIALLY_FILLED', 7000)],
    ]);
    const evictedIds: string[] = [];
    const evicted = evictOldestTerminalOrdersIfOverCap(m, 3, (o) => evictedIds.push(o.id));
    expect(evicted).toBe(2);
    expect(evictedIds).toEqual(['old-fill', 'mid-cancel']); // oldest terminal first
    expect(m.has('pending')).toBe(true);
    expect(m.has('partial')).toBe(true);
    expect(m.has('new-reject')).toBe(true);
    expect(m.size).toBe(3);
  });

  it('keeps all non-terminal orders even when that leaves the registry over cap', () => {
    const m = new Map<string, Order>([
      ['p1', order('p1', 'PENDING', 1000)],
      ['p2', order('p2', 'PARTIALLY_FILLED', 2000)],
      ['t1', order('t1', 'FILLED', 3000)],
    ]);
    // Cap 1: only the single terminal order can be evicted; the two open ones must stay.
    expect(evictOldestTerminalOrdersIfOverCap(m, 1)).toBe(1);
    expect(m.has('p1')).toBe(true);
    expect(m.has('p2')).toBe(true);
  });
});

describe('BoundedWarnOnce', () => {
  it('warns once per id while within capacity', () => {
    const w = new BoundedWarnOnce(10);
    expect(w.warn('a')).toBe(true);
    expect(w.warn('a')).toBe(false);
    expect(w.has('a')).toBe(true);
    expect(w.size).toBe(1);
  });

  it('evicts oldest ids past the cap (FIFO), so the registry stays bounded', () => {
    const w = new BoundedWarnOnce(3);
    w.warn('a'); w.warn('b'); w.warn('c');
    expect(w.size).toBe(3);
    w.warn('d');
    expect(w.size).toBe(3);
    expect(w.has('a')).toBe(false); // oldest forgotten -> will warn again (bounded working set)
    expect(w.warn('a')).toBe(true);
    expect(w.has('b')).toBe(false); // 'a' re-added, 'b' is now oldest
    expect(w.has('d')).toBe(true);
  });

  it('never grows past the cap across many ids', () => {
    const w = new BoundedWarnOnce(50);
    for (let i = 0; i < 5000; i++) w.warn(`order-${i}`);
    expect(w.size).toBeLessThanOrEqual(50);
  });
});

describe('env tuning', () => {
  beforeEach(() => {
    delete process.env.ARGUS_PAPER_BROKER_ORDER_REGISTRY_MAX;
    delete process.env.ARGUS_OMS_WARN_ONCE_MAX;
  });
  afterEach(() => {
    delete process.env.ARGUS_PAPER_BROKER_ORDER_REGISTRY_MAX;
    delete process.env.ARGUS_OMS_WARN_ONCE_MAX;
  });

  it('defaults to compiled constants when env is unset or invalid', () => {
    expect(resolvePaperBrokerOrderRegistryMax()).toBe(DEFAULT_PAPER_BROKER_ORDER_REGISTRY_MAX_ENTRIES);
    expect(resolveOmsWarnOnceMax()).toBe(DEFAULT_OMS_WARN_ONCE_MAX_ENTRIES);
    process.env.ARGUS_PAPER_BROKER_ORDER_REGISTRY_MAX = 'banana';
    expect(resolvePaperBrokerOrderRegistryMax()).toBe(DEFAULT_PAPER_BROKER_ORDER_REGISTRY_MAX_ENTRIES);
  });

  it('honours positive-integer env overrides', () => {
    process.env.ARGUS_PAPER_BROKER_ORDER_REGISTRY_MAX = '250';
    process.env.ARGUS_OMS_WARN_ONCE_MAX = '77';
    expect(resolvePaperBrokerOrderRegistryMax()).toBe(250);
    expect(resolveOmsWarnOnceMax()).toBe(77);
  });
});
