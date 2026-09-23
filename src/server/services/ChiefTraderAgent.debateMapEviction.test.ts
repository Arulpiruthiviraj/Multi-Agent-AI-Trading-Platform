import { describe, it, expect, vi } from 'vitest';

const { mockDb } = vi.hoisted(() => {
  const builder: any = {
    from() { return builder; },
    where() { return builder; },
    orderBy() { return builder; },
    limit() { return builder; },
    all() { return Promise.resolve([]); },
    then(resolve: any, reject: any) { return Promise.resolve([]).then(resolve, reject); },
  };
  return { mockDb: { select: () => builder, insert: () => ({ values: () => Promise.resolve({}) }) } };
});

vi.mock('../db', () => ({ db: mockDb, dbPath: 'test.db', sqliteDb: { close: vi.fn() } }));
vi.mock('../core/EventBus', () => ({ eventBus: { on: vi.fn(), emit: vi.fn(), publish: vi.fn(), emitChiefApproval: vi.fn() } }));
vi.mock('../ai/AIRouter', () => ({ AIRouter: { getInstance: () => ({ routeConsensus: vi.fn(), routeTask: vi.fn(), hasAnyRoutableProvider: vi.fn() }) } }));

import { ChiefTraderAgent } from './ChiefTraderAgent';
import { tradingSafety } from '../config/tradingSafety';

/**
 * Real defect found and fixed (2026-09-22, CLI runtime forensics targeted follow-up, Part B - P1-A
 * heap-growth investigation). `lastDebateStartedAt` (a Map<symbol, timestamp>) was set on every
 * debate start with NO eviction anywhere - source-verified via grep against every sibling
 * per-symbol Map in this class (manualSideExpectations, pendingDebates,
 * consensusAggregationTimers), all of which explicitly delete their own entries. This proves the
 * fix (recordDebateStarted()'s opportunistic sweep) actually bounds growth for a large number of
 * distinct symbols, rather than asserting the implementation detail in isolation.
 */
describe('ChiefTraderAgent.recordDebateStarted (real defect: lastDebateStartedAt had no eviction)', () => {
  it('bounds Map growth: only recently-started debates survive after many distinct symbols are recorded over simulated time', () => {
    const agent = new ChiefTraderAgent() as any;
    const cooldownMs = tradingSafety.consensusDebateCooldownMs;
    let simulatedNow = 1_000_000_000_000;
    const realDateNow = Date.now;
    try {
      Date.now = () => simulatedNow;
      // Simulate 500 distinct symbols each starting a debate at a strictly increasing time, each
      // step advancing well past the sweep's 10x-cooldown staleness threshold relative to earlier
      // entries - a real, unbounded-growth-shaped stress pattern (a large, ever-changing discovery
      // universe), not a synthetic edge case.
      const stepMs = cooldownMs; // 1x cooldown per symbol - after ~10 symbols, entry #1 is stale.
      for (let i = 0; i < 500; i++) {
        simulatedNow += stepMs;
        agent.recordDebateStarted(`SYM${i}`);
      }
      const map: Map<string, number> = agent.lastDebateStartedAt;
      // Bounded: must not have accumulated all 500 distinct symbols - only entries within the
      // 10x-cooldown staleness window (a small, fixed multiple of the cooldown) should remain.
      expect(map.size).toBeLessThan(15);
      expect(map.size).toBeGreaterThan(0);
      // The most recently recorded symbol must always survive its own insertion.
      expect(map.has('SYM499')).toBe(true);
      // A symbol recorded far in the past (well beyond 10x cooldown ago) must have been evicted.
      expect(map.has('SYM0')).toBe(false);
    } finally {
      Date.now = realDateNow;
    }
  });

  it('never evicts an entry that is still within the real cooldown window (the debate-cooldown check above this map must stay correct)', () => {
    const agent = new ChiefTraderAgent() as any;
    const cooldownMs = tradingSafety.consensusDebateCooldownMs;
    let simulatedNow = 2_000_000_000_000;
    const realDateNow = Date.now;
    try {
      Date.now = () => simulatedNow;
      agent.recordDebateStarted('AAPL');
      simulatedNow += Math.floor(cooldownMs / 2); // still well within the real cooldown
      agent.recordDebateStarted('MSFT'); // triggers a sweep pass
      const map: Map<string, number> = agent.lastDebateStartedAt;
      expect(map.has('AAPL')).toBe(true); // must survive - still cooling, not stale
      expect(map.has('MSFT')).toBe(true);
    } finally {
      Date.now = realDateNow;
    }
  });
});
