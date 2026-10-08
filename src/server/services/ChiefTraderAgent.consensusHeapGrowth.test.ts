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
vi.mock('../core/EventBus', () => ({
  // NOTE: emit/publish/emitChiefApproval are plain no-ops, NOT vi.fn(): vi.fn() retains
  // every call's arguments in .mock.calls, which would fake a per-round heap leak in the
  // heap-retention test below (3 events/round x 230 rounds of retained payloads).
  eventBus: { on: vi.fn(), emit: () => {}, publish: () => {}, emitChiefApproval: () => {} },
}));
vi.mock('../ai/AIRouter', () => ({ AIRouter: { getInstance: () => ({ routeConsensus: vi.fn(), routeTask: vi.fn(), hasAnyRoutableProvider: vi.fn() }) } }));
vi.mock('../core/ideaGenerationGate', () => ({ isLiveIdeaGenerationEnabled: () => true }));

import { ChiefTraderAgent } from './ChiefTraderAgent';
import { isConsensusIdeaFresh } from '../core/consensusIdeaFreshness';

/**
 * 2026-10-08 leak hunt - warmup-vs-leak verdict for the CHIEFTRADER & CONSENSUS subsystem.
 *
 * Soak smoke showed RSS 314MB -> 416MB (+102MB) in ~2 min. This test answers whether the
 * ChiefTrader consensus path retains memory per round: it loops real evaluateConsensusSerialized()
 * rounds (2 independent agents, below-threshold -> the NO-TRADE path, incl. the interim-tally
 * bookkeeping) through the REAL production sweep sequence between rounds, and measures heap delta
 * with global.gc(). Run with NODE_OPTIONS=--expose-gc (skipped otherwise).
 *
 * Per-round retained heap ~= 0 after warmup  =>  the soak's RSS climb is V8 warmup
 * (JIT/code cache/young-gen growth before the first major GCs), not a ChiefTrader leak.
 */
const HAS_GC = typeof (globalThis as any).gc === 'function';

function settledHeapBytes(): number {
  (globalThis as any).gc();
  (globalThis as any).gc();
  return process.memoryUsage().heapUsed;
}

/** One full consensus round through the real serialized evaluation path (no approval: 0.6 < 0.75). */
async function runConsensusRound(agent: any, round: number): Promise<void> {
  const symbol = `HEAP${round}`;
  const traceId = `heap_trace_${round}`;
  agent.upsertIdea({ traceId, symbol, side: 'BUY', confidence: 0.6, reasoning: 'heap probe', agent: 'TechnicalAgent' });
  agent.upsertIdea({ traceId, symbol, side: 'BUY', confidence: 0.6, reasoning: 'heap probe', agent: 'QuantEngine' });
  await agent.evaluateConsensus(symbol, traceId);
  // Between-round production sweep, faithful to the constructor's timer callback order:
  // backdate this round's ideas past consensusIdeaMaxAgeMs, run the REAL
  // recordUnresolvedAsNoConsensus() (exercises the Fix-3 dead-round tally cleanup through the
  // production path - no DB writes happen for stale ideas), then the verbatim TTL filter.
  const staleAt = Date.now() - 10 * 60 * 1000;
  for (const idea of agent.recentIdeas) idea.receivedAt = staleAt;
  await agent.recordUnresolvedAsNoConsensus();
  agent.recentIdeas = agent.recentIdeas.filter(
    (i: any) => (agent.pendingDebates.get(i.symbol) || 0) > 0 || isConsensusIdeaFresh(i.receivedAt),
  );
}

describe('ChiefTraderAgent consensus-round heap retention (warmup vs leak)', () => {
  it.skipIf(!HAS_GC)('per-round retained heap stays flat across 200 real consensus rounds', async () => {
    const agent = new ChiefTraderAgent() as any;
    try {
      const WARMUP = 30;
      const ROUNDS = 200;
      for (let r = 0; r < WARMUP; r++) await runConsensusRound(agent, r);
      const before = settledHeapBytes();
      for (let r = WARMUP; r < WARMUP + ROUNDS; r++) await runConsensusRound(agent, r);
      const after = settledHeapBytes();
      const perRound = (after - before) / ROUNDS;
      console.log(`[heap-probe] baseline=${(before / 1048576).toFixed(1)}MB after=${(after / 1048576).toFixed(1)}MB perRound=${(perRound / 1024).toFixed(2)}KB/round`);
      // Generous budget: 15KB/round retained would already be 3MB over this loop - an
      // incident-class leak (the P1-A shape) is orders of magnitude larger. The deterministic
      // map-size assertions below are the strong signal; this is the general backstop.
      // (V8 heap deltas are noisy; keep this budget comfortably above observed ~10KB/round.)
      expect(perRound).toBeLessThan(15 * 1024);
      // Deterministic bounds on every per-symbol/per-round structure after the loop:
      expect(agent.recentIdeas.length).toBe(0); // TTL filter cleared every stale round
      expect(agent.interimEvaluationsSinceLastPersist.size).toBe(0); // Fix-3 dead-round cleanup
      expect(agent.pendingDebateFailClosed.size).toBe(0);
      expect(agent.pendingDebates.size).toBe(0);
      expect(agent.consensusAggregationTimers.size).toBe(0);
      // lastConsensusEvalAt legitimately retains one timestamp per evaluated symbol inside the
      // 10x-minInterval sweep window (they are all recent here) - bounded by symbols touched,
      // not by rounds: exactly ROUNDS+WARMUP entries, each ~100 bytes.
      expect(agent.lastConsensusEvalAt.size).toBeLessThanOrEqual(WARMUP + ROUNDS);
    } finally {
      agent.stop();
    }
  }, 120000);

  it('a fail-closed debate round is fully consumed and leaves no retained state', async () => {
    // hasAnyRoutableProvider() is vi.fn() -> undefined -> falsy: every debate attempt takes the
    // noRoutableProviders fail-closed path (the production AI-outage shape).
    const agent = new ChiefTraderAgent() as any;
    const flush = () => new Promise<void>((r) => setImmediate(r));
    try {
      const idea1 = { traceId: 'fc_trace_1', symbol: 'FC1', side: 'BUY', confidence: 0.65, reasoning: 'fail-closed probe', agent: 'TechnicalAgent' };
      await agent.reviewIdea(idea1);
      // Fail-closed recorded (no routable providers); evaluation debounced (1 vote < min-2).
      expect(agent.pendingDebateFailClosed.has('FC1')).toBe(true);

      const idea2 = { ...idea1, traceId: 'fc_trace_2', agent: 'QuantEngine' };
      await agent.reviewIdea(idea2);
      // Second independent vote -> immediate serialized evaluation, which must read-and-clear
      // the fail-closed entry (the P0.5 forensic capture path). 0.65 < 0.75 -> NO_TRADE.
      // Poll for completion rather than fixed flushes: the serialized evaluation chain
      // (queue -> DB writes -> forensic capture) needs an unbounded number of ticks.
      const deadline = Date.now() + 10000;
      while (agent.pendingDebateFailClosed.size !== 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(agent.pendingDebateFailClosed.size).toBe(0);
      expect(agent.consensusQueues.size).toBe(0);
      expect(agent.consensusAggregationTimers.size).toBe(0);
      expect(agent.pendingDebates.size).toBe(0);
    } finally {
      agent.stop();
    }
  });
});
