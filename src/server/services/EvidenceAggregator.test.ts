import { describe, it, expect } from 'vitest';
import { EvidenceAggregator, Evidence, netConfidenceFromVotes } from './EvidenceAggregator';
import { agentWeightConfig } from '../config/agentWeights';

function evidence(overrides: Partial<Evidence>): Evidence {
  return {
    traceId: 't1',
    symbol: 'AAPL',
    side: 'BUY',
    confidence: 0.8,
    agent: 'TechnicalAgent',
    reasoning: 'test',
    weight: 1.0,
    ...overrides,
  };
}

describe('EvidenceAggregator.aggregate', () => {
  it('returns HOLD with 0 confidence when there is no evidence', () => {
    const result = EvidenceAggregator.aggregate([]);
    expect(result.side).toBe('HOLD');
    expect(result.confidence).toBe(0);
  });

  it('reduces to a single agent\'s own confidence when it is the only voice', () => {
    const result = EvidenceAggregator.aggregate([evidence({ confidence: 0.9, weight: 0.25 })]);
    expect(result.side).toBe('BUY');
    expect(result.confidence).toBeCloseTo(0.9, 5);
  });

  it('a configured hard-veto agent HOLD (confidence > 0) penalizes BUY/SELL', () => {
    const hardVetoAgent = agentWeightConfig.consensusHardVetoAgents[0] ?? 'NewsAgent';
    const buy = evidence({ side: 'BUY', confidence: 0.9, agent: 'A', weight: 1.0 });
    const hold = evidence({ side: 'HOLD', confidence: 0.9, agent: hardVetoAgent, weight: 1.0 });
    const result = EvidenceAggregator.aggregate([buy, hold]);
    expect(result.side).toBe('BUY');
    expect(result.confidence).toBeCloseTo(netConfidenceFromVotes([buy], [hold]), 5);
    expect(result.disagreements.some(e => e.side === 'HOLD')).toBe(true);
  });

  it('FundamentalAgent/MacroAgent HOLD with confidence > 0 does not hard-veto unless configured', () => {
    const buy = evidence({ side: 'BUY', confidence: 0.9, agent: 'TechnicalAgent', weight: 0.25 });
    const quant = evidence({ side: 'BUY', confidence: 0.85, agent: 'QuantEngine', weight: 0.15 });
    const fundHold = evidence({ side: 'HOLD', confidence: 0.8, agent: 'FundamentalAgent', weight: 0.20, reasoning: 'soft caution' });
    const withoutFund = EvidenceAggregator.aggregate([buy, quant]);
    const withFund = EvidenceAggregator.aggregate([buy, quant, fundHold]);
    expect(withFund.confidence).toBeCloseTo(withoutFund.confidence, 10);
    expect(withFund.side).toBe('BUY');
  });

  it('pulls the winning side down by the configured disagreement penalty times the disagreeing evidence', () => {
    const buy = evidence({ side: 'BUY', confidence: 0.99, agent: 'A', weight: 0.85 });
    const sell = evidence({ side: 'SELL', confidence: 0.3, agent: 'B', weight: 0.20 });
    const result = EvidenceAggregator.aggregate([buy, sell]);
    expect(result.side).toBe('BUY');
    expect(result.confidence).toBeCloseTo(netConfidenceFromVotes([buy], [sell]), 5);
    expect(result.agreements).toHaveLength(1);
    expect(result.disagreements).toHaveLength(1);
  });

  it('picks SELL when its net weighted confidence beats BUY\'s', () => {
    const result = EvidenceAggregator.aggregate([
      evidence({ side: 'BUY', confidence: 0.5, agent: 'A', weight: 0.5 }),
      evidence({ side: 'SELL', confidence: 0.95, agent: 'B', weight: 1.0 }),
    ]);
    expect(result.side).toBe('SELL');
  });

  it('picks the first agreeing agent\'s reasoning and its first valid currentPrice', () => {
    const result = EvidenceAggregator.aggregate([
      evidence({ side: 'BUY', agent: 'A', reasoning: 'first reason', currentPrice: undefined, weight: 1.0 }),
      evidence({ side: 'BUY', agent: 'B', reasoning: 'second reason', currentPrice: 150.5, weight: 1.0 }),
    ]);
    expect(result.reasoning).toBe('first reason');
    expect(result.currentPrice).toBe(150.5);
  });

  it('Phase 1B: a dead agent voting HOLD/confidence:0 (exactly FundamentalAgent/MacroAgent\'s real DATA_UNAVAILABLE shape) does not dilute the weighted denominator at all - confirmed against the actual real payload shape, not just a generic HOLD case', () => {
    const withoutDeadAgent = EvidenceAggregator.aggregate([
      evidence({ side: 'BUY', confidence: 0.9, agent: 'TechnicalAgent', weight: 0.25 }),
    ]);
    const withDeadAgentsVoting = EvidenceAggregator.aggregate([
      evidence({ side: 'BUY', confidence: 0.9, agent: 'TechnicalAgent', weight: 0.25 }),
      evidence({ side: 'HOLD', confidence: 0, agent: 'FundamentalAgent', weight: 0.20, reasoning: 'DATA_UNAVAILABLE: Fundamental data providers not configured.' }),
      evidence({ side: 'HOLD', confidence: 0, agent: 'MacroAgent', weight: 0.15, reasoning: 'DATA_UNAVAILABLE: Macro data providers not configured.' }),
    ]);
    // If the dead agents' weight (0.20 + 0.15) were added to totalWeight without any matching
    // numerator contribution (since their confidence is 0), the result would be diluted below
    // TechnicalAgent's own 0.9 - this proves that never happens: both results are identical.
    expect(withDeadAgentsVoting.confidence).toBeCloseTo(withoutDeadAgent.confidence, 10);
    expect(withDeadAgentsVoting.confidence).toBeCloseTo(0.9, 5);
    expect(withDeadAgentsVoting.side).toBe('BUY');
  });

  it('never returns a negative confidence even when disagreement outweighs agreement', () => {
    const result = EvidenceAggregator.aggregate([
      evidence({ side: 'BUY', confidence: 0.2, agent: 'A', weight: 0.1 }),
      evidence({ side: 'SELL', confidence: 0.99, agent: 'B', weight: 1.0 }),
    ]);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });

  it('coalesces 50 TechnicalAgent BUY rows into a single independent vote', () => {
    const flood = Array.from({ length: 50 }, (_, i) => evidence({
      traceId: `t${i}`,
      confidence: 0.9,
      agent: 'TechnicalAgent',
      weight: 0.25,
    }));
    const kronos = evidence({ side: 'SELL', confidence: 0.85, agent: 'KronosEngine', weight: 0.2 });
    const coalesced = EvidenceAggregator.aggregate([...flood, kronos]);
    const oneEach = EvidenceAggregator.aggregate([
      evidence({ confidence: 0.9, agent: 'TechnicalAgent', weight: 0.25 }),
      kronos,
    ]);
    expect(coalesced.agreements).toHaveLength(1);
    expect(coalesced.confidence).toBeCloseTo(oneEach.confidence, 5);
  });
});
