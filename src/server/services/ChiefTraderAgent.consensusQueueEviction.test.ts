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

/**
 * Real defect found and fixed (2026-10-05 memory investigation). `consensusQueues`
 * (Map<symbol, Promise>) was set on every evaluateConsensus() with NO delete anywhere -
 * pinning one promise chain (and its evaluation closure) per symbol for process lifetime.
 * Unlike every sibling per-symbol Map in this class (all with explicit delete paths), this
 * one was the exception. This proves the fix actually evicts the entry once the chained
 * evaluation settles, while keeping it while a newer evaluation is still queued behind it.
 */
describe('ChiefTraderAgent.evaluateConsensus (real defect: consensusQueues never evicted)', () => {
  const flush = () => new Promise<void>((r) => setImmediate(r));

  it('removes the per-symbol queue entry once the chained evaluation settles', async () => {
    const agent = new ChiefTraderAgent() as any;
    agent.evaluateConsensusSerialized = async () => {};
    await agent.evaluateConsensus('AAPL', 'trace_test_1');
    await flush();
    await flush();
    expect(agent.consensusQueues.size).toBe(0);
  });

  it('keeps the entry while a newer evaluation is still queued behind the settling one', async () => {
    const agent = new ChiefTraderAgent() as any;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    agent.evaluateConsensusSerialized = () => gate;
    const first = agent.evaluateConsensus('AAPL', 'trace_1');
    const second = agent.evaluateConsensus('AAPL', 'trace_2');
    await flush();
    // First evaluation is gated (still running); the second is queued behind it - the map
    // must still hold the chain so the second evaluation is not orphaned.
    expect(agent.consensusQueues.size).toBe(1);
    release();
    await first;
    await second;
    await flush();
    await flush();
    expect(agent.consensusQueues.size).toBe(0);
  });

  it('does not break the queue when an evaluation rejects', async () => {
    const agent = new ChiefTraderAgent() as any;
    let calls = 0;
    agent.evaluateConsensusSerialized = async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
    };
    await expect(agent.evaluateConsensus('AAPL', 'trace_1')).rejects.toThrow('boom');
    // The second evaluation must still run (rejection must not poison the queue)...
    await agent.evaluateConsensus('AAPL', 'trace_2');
    expect(calls).toBe(2);
    await flush();
    await flush();
    // ...and the entry must still be evicted afterwards.
    expect(agent.consensusQueues.size).toBe(0);
  });
});
