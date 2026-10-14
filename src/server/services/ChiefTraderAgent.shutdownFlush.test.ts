import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb, recordConsensusTransaction } = vi.hoisted(() => {
  const builder: any = {
    from() { return builder; }, where() { return builder; }, orderBy() { return builder; }, limit() { return builder; },
    all() { return Promise.resolve([]); }, then(resolve: any, reject: any) { return Promise.resolve([]).then(resolve, reject); },
  };
  return { mockDb: { select: () => builder, insert: () => ({ values: () => Promise.resolve({}) }) }, recordConsensusTransaction: vi.fn(async () => 'ARG-TEST-1') };
});
vi.mock('../db', () => ({ db: mockDb }));
vi.mock('../core/EventBus', () => ({ eventBus: { on: vi.fn(), emit: vi.fn(), publish: vi.fn(), emitChiefApproval: vi.fn() } }));
vi.mock('../core/TransactionRegistry', () => ({ recordConsensusTransaction }));
vi.mock('../ai/AIRouter', () => ({ AIRouter: { getInstance: () => ({ routeConsensus: vi.fn(), routeTask: vi.fn(), hasAnyRoutableProvider: vi.fn().mockResolvedValue(true) }) } }));
vi.mock('../core/ideaGenerationGate', () => ({ isLiveIdeaGenerationEnabled: () => true }));

import { ChiefTraderAgent } from './ChiefTraderAgent';

describe('ChiefTraderAgent.flushPendingIdeasAtShutdown (2026-10-13)', () => {
  beforeEach(() => recordConsensusTransaction.mockClear());

  it('gives pooled, un-decided ideas an explicit NO_CONSENSUS fate (with their source traces) and empties the pool; it approves nothing', async () => {
    const agent: any = new ChiefTraderAgent();
    const now = Date.now();
    agent.recentIdeas = [
      { traceId: 'tA', symbol: 'AAPL', side: 'BUY', confidence: 0.55, agent: 'TechnicalAgent', reasoning: 'x', receivedAt: now },
      { traceId: 'tB', symbol: 'AAPL', side: 'BUY', confidence: 0.6, agent: 'KronosEngine', reasoning: 'y', receivedAt: now },
      { traceId: 'tC', symbol: 'MSFT', side: 'SELL', confidence: 0.5, agent: 'TechnicalAgent', reasoning: 'z', receivedAt: now },
    ];
    await agent.flushPendingIdeasAtShutdown();
    expect(recordConsensusTransaction).toHaveBeenCalledTimes(2); // one per symbol
    const calls = recordConsensusTransaction.mock.calls.map((c: any[]) => c[0]);
    for (const c of calls) expect(c.approved).toBe(false);
    const aapl = calls.find((c: any) => c.symbol === 'AAPL');
    expect(aapl.evidence.map((e: any) => e.sourceTraceId).sort()).toEqual(['tA', 'tB']);
    expect(agent.recentIdeas).toEqual([]);
    await agent.flushPendingIdeasAtShutdown();
    expect(recordConsensusTransaction).toHaveBeenCalledTimes(2); // idempotent: nothing left to record
  });

  it('a failing persist never throws out of the drain and still clears the pool', async () => {
    recordConsensusTransaction.mockRejectedValueOnce(new Error('db closed'));
    const agent: any = new ChiefTraderAgent();
    agent.recentIdeas = [{ traceId: 'tA', symbol: 'AAPL', side: 'BUY', confidence: 0.55, agent: 'TechnicalAgent', reasoning: 'x', receivedAt: Date.now() }];
    await expect(agent.flushPendingIdeasAtShutdown()).resolves.toBeUndefined();
    expect(agent.recentIdeas).toEqual([]);
  });
});
