import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockDb } = vi.hoisted(() => {
  const builder: any = {
    from() { return builder; },
    where() { return builder; },
    orderBy() { return builder; },
    limit() { return builder; },
    all() { return Promise.resolve([]); },
    then(resolve: any, reject: any) { return Promise.resolve([]).then(resolve, reject); },
  };
  const mockDb = {
    select: () => builder,
    insert: () => ({ values: () => Promise.resolve({}) }),
  };
  return { mockDb };
});

vi.mock('../db', () => ({ db: mockDb }));
vi.mock('../core/EventBus', () => ({ eventBus: { on: vi.fn(), emit: vi.fn(), publish: vi.fn(), emitChiefApproval: vi.fn() } }));
const { hasAnyRoutableProvider } = vi.hoisted(() => ({ hasAnyRoutableProvider: vi.fn() }));
vi.mock('../ai/AIRouter', () => ({ AIRouter: { getInstance: () => ({ routeConsensus: vi.fn(), routeTask: vi.fn(), hasAnyRoutableProvider }) } }));
vi.mock('../core/ideaGenerationGate', () => ({ isLiveIdeaGenerationEnabled: () => true }));

import { ChiefTraderAgent } from './ChiefTraderAgent';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { tradingSafety } from '../config/tradingSafety';

/**
 * FORENSIC AUDIT (2026-08-31, zero-trade consensus-blocker mission): real production data showed
 * 19 of that day's 20 STRONG-confidence CONSENSUS_TERMINAL_REASON rounds had exactly ONE
 * participating agent (QuantEngine), terminal reason INSUFFICIENT_AGENT_PARTICIPATION - despite
 * agent_predictions proving TechnicalAgent (and sometimes Fundamental/Macro) had cast a genuinely
 * fresh (10-29s old, well under consensusIdeaMaxAgeMs=60000ms), directional vote on the SAME
 * symbol moments before. Root cause: ChiefTraderAgent's constructor scheduled an UNCONDITIONAL
 * periodic sweep (chiefTraderIdeaTtlMs, also 60000ms) that wiped `recentIdeas` for any symbol with
 * no debate currently pending - anchored to wall-clock time since the agent was constructed, NOT
 * to each individual idea's own receivedAt. An idea could be discarded anywhere from 0ms to
 * 60000ms after arriving, purely by its phase alignment with that fixed-period tick - silently
 * capping the real consensus window well below the documented consensusIdeaMaxAgeMs, and denying
 * "2 independent agents" not because independence genuinely failed to form, but because one
 * agent's still-fresh vote was evicted before the second agent's vote ever arrived to combine
 * with it. Fixed by making the sweep age-aware (isConsensusIdeaFresh), never touching
 * CONSENSUS_APPROVAL_THRESHOLD or MIN_INDEPENDENT_AGREEING_AGENTS.
 */
describe('ChiefTraderAgent recentIdeas periodic sweep respects consensusIdeaMaxAgeMs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hasAnyRoutableProvider.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a still-fresh idea (well under consensusIdeaMaxAgeMs) through a sweep tick even with no debate pending - this is the exact real scenario that used to silently discard a second independent agent vote', () => {
    const agent: any = new ChiefTraderAgent();
    agent.recentIdeas = [];

    // Let almost a full sweep period elapse with nothing tracked, so the next scheduled tick is
    // close when the idea is added - mirrors real production timing (an idea can land at any
    // arbitrary phase relative to the process's fixed sweep schedule).
    const msUntilNextSweep = 5000;
    vi.advanceTimersByTime(runtimeIntervals.chiefTraderIdeaTtlMs - msUntilNextSweep);

    const receivedAt = Date.now();
    agent.recentIdeas = [
      { traceId: 't1', symbol: 'AAPL', side: 'BUY', confidence: 0.55, agent: 'TechnicalAgent', reasoning: 'tech', receivedAt },
    ];

    // Advance just past the sweep tick. At the instant the sweep fires, the idea is only
    // msUntilNextSweep old - far under consensusIdeaMaxAgeMs.
    vi.advanceTimersByTime(msUntilNextSweep + 1);
    expect(msUntilNextSweep + 1).toBeLessThan(tradingSafety.consensusIdeaMaxAgeMs);

    expect(agent.recentIdeas.length).toBe(1);
    expect(agent.recentIdeas[0].traceId).toBe('t1');
  });

  it('still discards an idea once it is genuinely stale (past consensusIdeaMaxAgeMs), even with no debate pending - the sweep must not become a no-op', () => {
    const agent: any = new ChiefTraderAgent();
    agent.recentIdeas = [];

    const receivedAt = Date.now();
    agent.recentIdeas = [
      { traceId: 't1', symbol: 'AAPL', side: 'BUY', confidence: 0.55, agent: 'TechnicalAgent', reasoning: 'tech', receivedAt },
    ];

    // Advance well past consensusIdeaMaxAgeMs and past the sweep interval - the idea is now
    // genuinely stale, so it must be cleaned up.
    vi.advanceTimersByTime(tradingSafety.consensusIdeaMaxAgeMs + runtimeIntervals.chiefTraderIdeaTtlMs);

    expect(agent.recentIdeas.length).toBe(0);
  });

  it('keeps ideas for a symbol with a debate currently pending regardless of age (unchanged prior behavior)', () => {
    const agent: any = new ChiefTraderAgent();
    agent.recentIdeas = [];
    agent.pendingDebates = new Map([['AAPL', 1]]);

    const receivedAt = Date.now();
    agent.recentIdeas = [
      { traceId: 't1', symbol: 'AAPL', side: 'BUY', confidence: 0.55, agent: 'TechnicalAgent', reasoning: 'tech', receivedAt },
    ];
    vi.advanceTimersByTime(runtimeIntervals.chiefTraderIdeaTtlMs + 1);

    expect(agent.recentIdeas.length).toBe(1);
  });
});
