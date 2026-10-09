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

function staleIdea(symbol: string) {
  return {
    traceId: `trace_${symbol}`,
    symbol,
    agent: 'TechnicalAgent',
    side: 'BUY',
    confidence: 0.6,
    reasoning: 'stale round',
    // Well past consensusIdeaMaxAgeMs: this round is dead - the sweep can never persist a row
    // for it (relevantIdeas will be empty).
    receivedAt: Date.now() - tradingSafety.consensusIdeaMaxAgeMs * 10,
  };
}

/**
 * Real defect found and fixed (2026-10-08 leak hunt). `interimEvaluationsSinceLastPersist`
 * (Map<symbol, count>) was incremented on every NO-TRADE evaluation but only deleted when a
 * consensus_decisions row was actually persisted (APPROVED, or the sweep's NO_CONSENSUS row).
 * A symbol whose ideas went stale between the sweep and the TTL filter - so no row was ever
 * persisted for its round - kept its tally entry for process lifetime, AND the stale count
 * would corrupt the NEXT round's collapse ratio when a row was finally persisted. These tests
 * prove the sweep's dead-round skip path now releases the tally, while a round with a debate
 * still in flight (still alive) keeps its tally untouched.
 */
describe('ChiefTraderAgent.recordUnresolvedAsNoConsensus (real defect: interim tally never released for dead rounds)', () => {
  it('deletes the interim tally for a dead round (stale ideas, no row will ever be persisted)', async () => {
    const agent = new ChiefTraderAgent() as any;
    agent.recentIdeas = [staleIdea('STALE1'), staleIdea('STALE2')];
    agent.interimEvaluationsSinceLastPersist.set('STALE1', 7);
    agent.interimEvaluationsSinceLastPersist.set('STALE2', 3);
    await agent.recordUnresolvedAsNoConsensus();
    expect(agent.interimEvaluationsSinceLastPersist.has('STALE1')).toBe(false);
    expect(agent.interimEvaluationsSinceLastPersist.has('STALE2')).toBe(false);
    agent.stop();
  });

  it('keeps the tally while a debate is still in flight for the symbol (round still alive)', async () => {
    const agent = new ChiefTraderAgent() as any;
    agent.recentIdeas = [staleIdea('DEBATE1')];
    agent.interimEvaluationsSinceLastPersist.set('DEBATE1', 5);
    agent.beginDebate('DEBATE1');
    try {
      await agent.recordUnresolvedAsNoConsensus();
      // The debatePending guard runs before the dead-round cleanup - the tally must survive.
      expect(agent.interimEvaluationsSinceLastPersist.get('DEBATE1')).toBe(5);
    } finally {
      agent.endDebate('DEBATE1');
      agent.stop();
    }
  });

  it('does not touch tallies of symbols with no recentIdeas entry at all', async () => {
    const agent = new ChiefTraderAgent() as any;
    agent.recentIdeas = [];
    agent.interimEvaluationsSinceLastPersist.set('GHOST', 2);
    await agent.recordUnresolvedAsNoConsensus();
    // No ideas for GHOST at sweep time: the sweep iterates symbols from recentIdeas, so there
    // is nothing to clean here - and nothing must be fabricated either. (In production the TTL
    // sweep runs immediately after this method in the same timer tick, so a symbol with no
    // ideas at all cannot carry a live round.)
    expect(agent.interimEvaluationsSinceLastPersist.get('GHOST')).toBe(2);
    agent.stop();
  });
});
