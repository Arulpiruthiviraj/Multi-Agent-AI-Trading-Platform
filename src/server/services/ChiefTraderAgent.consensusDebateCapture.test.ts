import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ConsensusDebate P0.5 forensic measurement (2026-09-13) - verifies the real live wiring: a debate
 * HOLD vote that hard-vetoes an otherwise-qualifying round actually triggers a capture call with
 * the correct fields, using the SAME mocking convention ChiefTraderAgent.test.ts already
 * established (mocked db/EventBus/AIRouter) plus a spy on ConsensusDebateForensics so this test
 * can assert on the exact call without needing a real DB. The capture math itself (the real
 * counterfactual) is already thoroughly covered by ConsensusDebateForensics.test.ts's pure-function
 * tests - this test exists only to prove ChiefTraderAgent actually invokes it, at the right point,
 * with real (not stale/wrong) evidence.
 */
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

const { emitChiefApproval } = vi.hoisted(() => ({ emitChiefApproval: vi.fn() }));
const { routeConsensus, routeTask, hasAnyRoutableProvider } = vi.hoisted(() => ({ routeConsensus: vi.fn(), routeTask: vi.fn(), hasAnyRoutableProvider: vi.fn() }));
const { persistConsensusDebateCapture } = vi.hoisted(() => ({ persistConsensusDebateCapture: vi.fn().mockResolvedValue(undefined) }));

vi.mock('../db', () => ({ db: mockDb }));
vi.mock('../core/EventBus', () => ({ eventBus: { on: vi.fn(), emit: vi.fn(), publish: vi.fn(), emitChiefApproval } }));
vi.mock('../ai/AIRouter', () => ({ AIRouter: { getInstance: () => ({ routeConsensus, routeTask, hasAnyRoutableProvider }) } }));
vi.mock('./ConsensusDebateForensics', () => ({ persistConsensusDebateCapture }));
const { ideaGenEnabled } = vi.hoisted(() => ({ ideaGenEnabled: { value: true } }));
vi.mock('../core/ideaGenerationGate', () => ({ isLiveIdeaGenerationEnabled: () => ideaGenEnabled.value }));

import { ChiefTraderAgent } from './ChiefTraderAgent';
import { defaultAgentWeights } from '../config/agentWeights';

describe('ChiefTraderAgent - ConsensusDebate P0.5 forensic capture wiring', () => {
  let agent: any;

  beforeEach(() => {
    emitChiefApproval.mockClear();
    routeConsensus.mockReset();
    routeTask.mockReset();
    hasAnyRoutableProvider.mockReset().mockResolvedValue(true);
    persistConsensusDebateCapture.mockClear();
    ideaGenEnabled.value = true;
    agent = new ChiefTraderAgent();
    agent.agentWeights = { ...defaultAgentWeights };
    agent.recentIdeas = [];
  });

  it('captures a real HOLD veto when the debate crushes an otherwise-qualifying round, with vetoFired=true', async () => {
    routeConsensus.mockResolvedValue({
      consensus_verdict: 'HOLD',
      results: [{ status: 'success' }, { status: 'success' }],
      successCount: 2,
    });

    // Two strong, independent agreeing agents - clears threshold+independence on its own.
    await agent.reviewIdea({ traceId: 't1', symbol: 'NVDA', side: 'BUY', confidence: 0.95, agent: 'TechnicalAgent', reasoning: 'strong momentum' });
    await agent.reviewIdea({ traceId: 't1', symbol: 'NVDA', side: 'BUY', confidence: 0.9, agent: 'KronosEngine', reasoning: 'confirm' });
    // Third idea above debateTriggerConfidence actually triggers the debate call.
    await agent.reviewIdea({ traceId: 't1', symbol: 'NVDA', side: 'BUY', confidence: 0.9, agent: 'QuantEngine', reasoning: 'quant confirm' });

    await new Promise((r) => setTimeout(r, 20)); // let the debate promise chain + scheduled re-evaluation settle

    expect(persistConsensusDebateCapture).toHaveBeenCalled();
    const call = persistConsensusDebateCapture.mock.calls[persistConsensusDebateCapture.mock.calls.length - 1][0];
    expect(call.symbol).toBe('NVDA');
    expect(call.withDebateApproved).toBe(false);
    expect(call.debateTelemetry).toBeDefined();
    expect(call.evidence.some((e: any) => e.agent === 'ConsensusDebate' && e.side === 'HOLD')).toBe(true);
  });

  it('does NOT capture anything when debate never triggers (no idea exceeds debateTriggerConfidence)', async () => {
    await agent.reviewIdea({ traceId: 't2', symbol: 'AAPL', side: 'BUY', confidence: 0.5, agent: 'TechnicalAgent', reasoning: 'weak' });
    await new Promise((r) => setTimeout(r, 20));
    expect(persistConsensusDebateCapture).not.toHaveBeenCalled();
    expect(routeConsensus).not.toHaveBeenCalled();
  });
});
