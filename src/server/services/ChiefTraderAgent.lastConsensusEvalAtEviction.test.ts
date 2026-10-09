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
 * Real defect found and fixed (2026-10-08 leak hunt). `lastConsensusEvalAt` (Map<symbol,
 * timestamp>) was set on every scheduled/serialized consensus evaluation and had exactly ONE
 * delete path: a debate's .finally() for that symbol. A symbol whose ideas never triggered a
 * debate kept its entry for process lifetime - the same unbounded-per-symbol-Map class as the
 * 2026-09-22 lastDebateStartedAt finding. This proves recordConsensusEval()'s opportunistic
 * sweep actually bounds growth for a large number of distinct symbols, while never evicting an
 * entry that could still affect the same-agent-replacement throttle (the map's only read).
 */
describe('ChiefTraderAgent.recordConsensusEval (real defect: lastConsensusEvalAt had no eviction without a debate)', () => {
  it('bounds Map growth: only recently-evaluated symbols survive after many distinct symbols over simulated time', () => {
    const agent = new ChiefTraderAgent() as any;
    const minIntervalMs = tradingSafety.consensusEvalMinIntervalMs;
    let simulatedNow = 1_000_000_000_000;
    const realDateNow = Date.now;
    try {
      Date.now = () => simulatedNow;
      // 500 distinct symbols evaluated at strictly increasing times, each step far past the
      // sweep's 10x-minInterval staleness threshold relative to earlier entries - a real,
      // unbounded-growth-shaped stress pattern (a large, ever-changing discovery universe).
      const stepMs = minIntervalMs * 20; // 2x the sweep threshold per symbol
      for (let i = 0; i < 500; i++) {
        simulatedNow += stepMs;
        agent.recordConsensusEval(`SYM${i}`);
      }
      const map: Map<string, number> = agent.lastConsensusEvalAt;
      // Bounded: must not have accumulated all 500 distinct symbols.
      expect(map.size).toBeLessThan(15);
      expect(map.size).toBeGreaterThan(0);
      // The most recently recorded symbol must always survive its own insertion.
      expect(map.has('SYM499')).toBe(true);
      // A symbol recorded far in the past (well beyond 10x minInterval ago) must be evicted.
      expect(map.has('SYM0')).toBe(false);
    } finally {
      Date.now = realDateNow;
    }
  });

  it('never evicts an entry that could still affect the same-agent-replacement throttle', () => {
    const agent = new ChiefTraderAgent() as any;
    const minIntervalMs = tradingSafety.consensusEvalMinIntervalMs;
    let simulatedNow = 2_000_000_000_000;
    const realDateNow = Date.now;
    try {
      Date.now = () => simulatedNow;
      agent.recordConsensusEval('AAPL');
      simulatedNow += Math.floor(minIntervalMs / 2); // still within the real throttle window
      agent.recordConsensusEval('MSFT'); // triggers a sweep pass
      const map: Map<string, number> = agent.lastConsensusEvalAt;
      expect(map.has('AAPL')).toBe(true); // must survive - still throttling, not stale
      expect(map.has('MSFT')).toBe(true);
    } finally {
      Date.now = realDateNow;
    }
  });

  it('records the evaluation timestamp (the throttle read path still sees the latest eval)', () => {
    const agent = new ChiefTraderAgent() as any;
    const before = Date.now();
    agent.recordConsensusEval('AAPL');
    const map: Map<string, number> = agent.lastConsensusEvalAt;
    expect(map.get('AAPL')).toBeGreaterThanOrEqual(before);
    expect(map.get('AAPL')).toBeLessThanOrEqual(Date.now());
  });
});
