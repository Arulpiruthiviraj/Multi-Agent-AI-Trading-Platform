import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb } = vi.hoisted(() => {
  const builder: any = {
    from() { return builder; },
    where() { return builder; },
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

vi.mock('../db', () => ({ db: mockDb }));
vi.mock('../core/EventBus', () => ({ eventBus: { on: vi.fn(), emit: vi.fn(), emitChiefApproval } }));
vi.mock('../ai/AIRouter', () => ({ AIRouter: { getInstance: () => ({ routeConsensus: vi.fn() }) } }));

import { ChiefTraderAgent } from './ChiefTraderAgent';

describe('ChiefTraderAgent.evaluateConsensus', () => {
  let agent: any;

  beforeEach(() => {
    emitChiefApproval.mockClear();
    agent = new ChiefTraderAgent();
    agent.agentWeights = {
      TechnicalAgent: 0.25,
      FundamentalAgent: 0.20,
      MacroAgent: 0.15,
      NewsAgent: 0.25,
      QuantEngine: 0.15,
      KronosEngine: 0.20,
    };
    agent.recentIdeas = [];
  });

  it('approves when strong single-agent confidence clears the 0.75 threshold', async () => {
    agent.recentIdeas = [
      { traceId: 't1', symbol: 'AAPL', side: 'BUY', confidence: 0.95, agent: 'TechnicalAgent', reasoning: 'strong momentum' },
    ];

    await agent.evaluateConsensus('AAPL', 't1');

    // TechnicalAgent has weight 0.25 but is the ONLY voice, so weightedConfidence/totalWeight
    // reduces to its own raw confidence (0.95) regardless of its absolute weight.
    expect(emitChiefApproval).toHaveBeenCalledTimes(1);
    const approval = emitChiefApproval.mock.calls[0][0];
    expect(approval.side).toBe('BUY');
    expect(approval.confidence).toBeCloseTo(0.95, 5);
  });

  it('does not approve when weighted confidence stays at or below 0.75', async () => {
    agent.recentIdeas = [
      { traceId: 't2', symbol: 'AAPL', side: 'BUY', confidence: 0.7, agent: 'TechnicalAgent', reasoning: 'weak signal' },
    ];

    await agent.evaluateConsensus('AAPL', 't2');

    expect(emitChiefApproval).not.toHaveBeenCalled();
  });

  it('reduces weighted confidence when agents disagree, but still approves if it clears 0.75', async () => {
    agent.recentIdeas = [
      { traceId: 't3', symbol: 'AAPL', side: 'BUY', confidence: 0.99, agent: 'TechnicalAgent', reasoning: 'buy A' },
      { traceId: 't3', symbol: 'AAPL', side: 'BUY', confidence: 0.99, agent: 'NewsAgent', reasoning: 'buy B' },
      { traceId: 't3', symbol: 'AAPL', side: 'BUY', confidence: 0.99, agent: 'FundamentalAgent', reasoning: 'buy C' },
      { traceId: 't3', symbol: 'AAPL', side: 'BUY', confidence: 0.99, agent: 'QuantEngine', reasoning: 'buy D' },
      { traceId: 't3', symbol: 'AAPL', side: 'SELL', confidence: 0.3, agent: 'KronosEngine', reasoning: 'weak sell' },
    ];

    await agent.evaluateConsensus('AAPL', 't3');

    expect(emitChiefApproval).toHaveBeenCalledTimes(1);
    const approval = emitChiefApproval.mock.calls[0][0];
    expect(approval.side).toBe('BUY');
    // weighted = 0.99*(.25+.25+.20+.15) - 0.3*.20*0.5 = 0.8415 - 0.03 = 0.8115
    // totalWeight = 0.85 + 0.20 = 1.05 -> finalConfidence = 0.8115/1.05 ≈ 0.7729
    expect(approval.confidence).toBeCloseTo(0.8115 / 1.05, 4);
    // Strictly less than the undiluted (no-disagreement) confidence of 0.99 - the disagreement
    // must have actually pulled the number down, not been silently ignored.
    expect(approval.confidence).toBeLessThan(0.99);
    expect(approval.confidence).toBeGreaterThan(0.75);
  });

  it('does not approve at all when disagreement pulls the winning side at/below the 0.75 approval bar', async () => {
    agent.recentIdeas = [
      { traceId: 't4', symbol: 'AAPL', side: 'BUY', confidence: 0.95, agent: 'TechnicalAgent', reasoning: 'buy A' },
      { traceId: 't4', symbol: 'AAPL', side: 'BUY', confidence: 0.95, agent: 'NewsAgent', reasoning: 'buy B' },
      { traceId: 't4', symbol: 'AAPL', side: 'SELL', confidence: 0.95, agent: 'MacroAgent', reasoning: 'sell C' },
    ];

    await agent.evaluateConsensus('AAPL', 't4');

    // weighted = (0.95*0.25 + 0.95*0.25) - (0.95*0.15*0.5) = 0.40375; totalWeight = 0.65
    // finalConfidence = 0.40375/0.65 ≈ 0.621, below the 0.75 approval bar.
    expect(emitChiefApproval).not.toHaveBeenCalled();
  });

  it('gives an unweighted agent (not in agentWeights) a default weight of 1.0', async () => {
    agent.recentIdeas = [
      { traceId: 't5', symbol: 'AAPL', side: 'BUY', confidence: 0.8, agent: 'BrandNewAgent', reasoning: 'novel signal' },
    ];

    await agent.evaluateConsensus('AAPL', 't5');

    expect(emitChiefApproval).toHaveBeenCalledTimes(1);
    const approval = emitChiefApproval.mock.calls[0][0];
    expect(approval.confidence).toBeCloseTo(0.8, 5);
    expect(approval.agentsContext).toContain('BrandNewAgent(wt:1.00)');
  });

  it('gives the ConsensusDebate pseudo-agent a default weight of 0.35 when unweighted', async () => {
    agent.recentIdeas = [
      { traceId: 't6', symbol: 'AAPL', side: 'BUY', confidence: 0.9, agent: 'ConsensusDebate', reasoning: 'debate result' },
    ];

    await agent.evaluateConsensus('AAPL', 't6');

    expect(emitChiefApproval).toHaveBeenCalledTimes(1);
    const approval = emitChiefApproval.mock.calls[0][0];
    expect(approval.confidence).toBeCloseTo(0.9, 5);
    expect(approval.agentsContext).toContain('ConsensusDebate(wt:0.35)');
  });
});
