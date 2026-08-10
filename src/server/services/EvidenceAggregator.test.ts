import { describe, it, expect } from 'vitest';
import { EvidenceAggregator, Evidence } from './EvidenceAggregator';

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

  it('HOLD evidence neither supports nor penalizes a BUY/SELL side', () => {
    const result = EvidenceAggregator.aggregate([
      evidence({ side: 'BUY', confidence: 0.9, agent: 'A', weight: 1.0 }),
      evidence({ side: 'HOLD', confidence: 0.9, agent: 'B', weight: 1.0 }),
    ]);
    // If HOLD counted as a disagreement, confidence would be pulled down below 0.9.
    expect(result.side).toBe('BUY');
    expect(result.confidence).toBeCloseTo(0.9, 5);
  });

  it('pulls the winning side down by half the disagreeing evidence\'s weighted confidence', () => {
    const result = EvidenceAggregator.aggregate([
      evidence({ side: 'BUY', confidence: 0.99, agent: 'A', weight: 0.85 }),
      evidence({ side: 'SELL', confidence: 0.3, agent: 'B', weight: 0.20 }),
    ]);
    // weighted = 0.99*0.85 - 0.3*0.20*0.5 = 0.8415 - 0.03 = 0.8115; totalWeight = 1.05
    expect(result.side).toBe('BUY');
    expect(result.confidence).toBeCloseTo(0.8115 / 1.05, 5);
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

  it('never returns a negative confidence even when disagreement outweighs agreement', () => {
    const result = EvidenceAggregator.aggregate([
      evidence({ side: 'BUY', confidence: 0.2, agent: 'A', weight: 0.1 }),
      evidence({ side: 'SELL', confidence: 0.99, agent: 'B', weight: 1.0 }),
    ]);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });
});
