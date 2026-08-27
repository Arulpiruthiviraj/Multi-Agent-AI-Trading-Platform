import { describe, it, expect } from 'vitest';
import { classifyVote, computeDebateMarginFromResults, computeShadowConsensus } from './EvidenceAwareVote';
import type { Evidence } from './EvidenceAggregator';

function ev(overrides: Partial<Evidence>): Evidence {
  return {
    traceId: 'trace_TEST_1_aaaa', symbol: 'TEST', side: 'HOLD', confidence: 0,
    agent: 'TestAgent', reasoning: '', weight: 1, ...overrides,
  };
}

describe('classifyVote', () => {
  it('classifies the real production bug: a recalibrated non-zero confidence still reports DATA_UNAVAILABLE from the original reasoning text', () => {
    // Real observed shape: raw confidence 0 (DATA_UNAVAILABLE) recalibrated by
    // ChiefTraderAgent.calibrateConfidence() to 0.532 before reaching EvidenceAggregator - the
    // reasoning string is untouched by calibration, so it is still detectable.
    const vote = classifyVote(ev({
      agent: 'FundamentalAgent', side: 'HOLD', confidence: 0.532258064516129,
      reasoning: 'DATA_UNAVAILABLE: AlphaVantage daily rate limit exhausted - real data resumes after a 24h cooldown.',
    }));
    expect(vote.evidenceState).toBe('DATA_UNAVAILABLE');
    expect(vote.usableForConsensus).toBe(false);
    expect(vote.evidenceQuality).toBe(0);
    expect(vote.reasonCode).toBe('DATA_UNAVAILABLE_CALIBRATION_OVERRIDE_IGNORED');
  });

  it('classifies a genuine BUY as BULLISH and usable', () => {
    const vote = classifyVote(ev({ agent: 'TechnicalAgent', side: 'BUY', confidence: 0.656, reasoning: 'MACD bullish crossover' }));
    expect(vote.evidenceState).toBe('BULLISH');
    expect(vote.usableForConsensus).toBe(true);
    expect(vote.evidenceQuality).toBe(0.656);
  });

  it('classifies a genuine SELL as BEARISH and usable', () => {
    const vote = classifyVote(ev({ agent: 'QuantEngine', side: 'SELL', confidence: 0.7, reasoning: 'BEARISH_TREND regime' }));
    expect(vote.evidenceState).toBe('BEARISH');
    expect(vote.usableForConsensus).toBe(true);
  });

  it('classifies a low-confidence data-available HOLD as UNCERTAIN, not NEUTRAL', () => {
    const vote = classifyVote(ev({ agent: 'TechnicalAgent', side: 'HOLD', confidence: 0.15, reasoning: 'Mixed signals, no clear setup' }));
    expect(vote.evidenceState).toBe('UNCERTAIN');
    expect(vote.usableForConsensus).toBe(true);
    expect(vote.reasonCode).toBe('WEAK_HOLD_NOT_A_VETO');
  });

  it('classifies a higher-confidence data-available HOLD as NEUTRAL (genuine no-edge)', () => {
    const vote = classifyVote(ev({ agent: 'TechnicalAgent', side: 'HOLD', confidence: 0.6, reasoning: 'Range-bound, no directional edge' }));
    expect(vote.evidenceState).toBe('NEUTRAL');
    expect(vote.reasonCode).toBe('GENUINE_NO_EDGE');
  });

  it('classifies a fail-closed ConsensusDebate HOLD as MODEL_FAILED, not real evidence', () => {
    const vote = classifyVote(ev({
      agent: 'ConsensusDebate', side: 'HOLD', confidence: 0.8,
      reasoning: 'Multi-Model Debate fail-closed HOLD (0 of 2 providers returned a usable verdict). Adversarial debate did not produce a usable verdict.',
    }));
    expect(vote.evidenceState).toBe('MODEL_FAILED');
    expect(vote.usableForConsensus).toBe(false);
  });
});

describe('computeDebateMarginFromResults', () => {
  it('Case A - strong bearish consensus: two models independently conclude SELL with high confidence', () => {
    const r = computeDebateMarginFromResults([
      { decision: 'SELL', confidence: 90, status: 'success' },
      { decision: 'SELL', confidence: 85, status: 'success' },
    ]);
    expect(r.evidenceState).toBe('BEARISH');
    expect(r.marginStrength).toBeCloseTo(1, 5);
    expect(r.shadowConfidence).toBeGreaterThan(0.5);
  });

  it('Case B - uncertain debate: models disagree with no clear majority', () => {
    const r = computeDebateMarginFromResults([
      { decision: 'BUY', confidence: 55, status: 'success' },
      { decision: 'HOLD', confidence: 50, status: 'success' },
    ]);
    expect(r.evidenceState).toBe('UNCERTAIN');
    expect(r.shadowConfidence).toBeLessThan(0.3);
  });

  it('Case C - no usable debate: every model failed or timed out', () => {
    const r = computeDebateMarginFromResults([
      { status: 'error' },
      { status: 'error' },
    ]);
    expect(r.evidenceState).toBe('MODEL_FAILED');
    expect(r.shadowConfidence).toBe(0);
    expect(r.successCount).toBe(0);
  });

  it('Case D - weak HOLD: models lean HOLD but without a strong margin', () => {
    const r = computeDebateMarginFromResults([
      { decision: 'HOLD', confidence: 55, status: 'success' },
      { decision: 'BUY', confidence: 45, status: 'success' },
    ]);
    expect(r.evidenceState).toBe('UNCERTAIN');
    // Must NOT behave like a high-confidence veto (the old flat 0.8).
    expect(r.shadowConfidence).toBeLessThan(0.8);
  });

  it('never fabricates a margin when only one model responds - reflects reduced completeness', () => {
    const oneModel = computeDebateMarginFromResults([{ decision: 'SELL', confidence: 90, status: 'success' }]);
    const twoModel = computeDebateMarginFromResults([
      { decision: 'SELL', confidence: 90, status: 'success' },
      { decision: 'SELL', confidence: 90, status: 'success' },
    ]);
    expect(oneModel.shadowConfidence).toBeLessThan(twoModel.shadowConfidence);
  });
});

describe('computeShadowConsensus - the 10 required Part B scenarios', () => {
  const weights = { TechnicalAgent: 1, QuantEngine: 1, FundamentalAgent: 0.8, KronosEngine: 1, ConsensusDebate: 0.9, NewsAgent: 0.7 };
  const threshold = 0.75;

  it('1. BUY + BUY + DATA_UNAVAILABLE: the unavailable vote is excluded, not counted as a dissent', () => {
    const votes = [
      classifyVote(ev({ agent: 'TechnicalAgent', side: 'BUY', confidence: 0.8, reasoning: 'strong trend' })),
      classifyVote(ev({ agent: 'QuantEngine', side: 'BUY', confidence: 0.82, reasoning: 'bullish regime' })),
      classifyVote(ev({ agent: 'FundamentalAgent', side: 'HOLD', confidence: 0.5, reasoning: 'DATA_UNAVAILABLE: rate limit exhausted' })),
    ];
    const result = computeShadowConsensus(votes, weights, threshold);
    expect(result.excludedAgents).toEqual([{ agent: 'FundamentalAgent', reason: 'DATA_UNAVAILABLE_CALIBRATION_OVERRIDE_IGNORED' }]);
    expect(result.finalDecision).toBe('BUY');
    expect(result.bullishEvidence).toBeGreaterThan(threshold);
  });

  it('2. BUY + HOLD with weak evidence: weak HOLD should not block a strong BUY the way a veto would', () => {
    const votes = [
      classifyVote(ev({ agent: 'TechnicalAgent', side: 'BUY', confidence: 0.85, reasoning: 'strong breakout' })),
      classifyVote(ev({ agent: 'QuantEngine', side: 'HOLD', confidence: 0.1, reasoning: 'no strong regime signal' })),
    ];
    const result = computeShadowConsensus(votes, weights, threshold);
    // Uncertainty from the weak HOLD should be small since it carries low weight in the aggregate.
    expect(result.finalDecision).toBe('BUY');
  });

  it('3. BUY + HOLD with strong negative evidence (SELL): genuine opposing evidence should suppress approval', () => {
    const votes = [
      classifyVote(ev({ agent: 'TechnicalAgent', side: 'BUY', confidence: 0.7, reasoning: 'bullish crossover' })),
      classifyVote(ev({ agent: 'ConsensusDebate', side: 'SELL', confidence: 0.9, reasoning: 'Multi-Model Debate Concluded: SELL (Based on 2 successful models; 0 failed)' })),
    ];
    const result = computeShadowConsensus(votes, weights, threshold);
    expect(result.bearishEvidence).toBeGreaterThan(0);
    expect(result.finalDecision).not.toBe('BUY');
  });

  it('4. BUY + SELL disagreement: genuine two-sided evidence should not resolve to a confident approval either way', () => {
    const votes = [
      classifyVote(ev({ agent: 'TechnicalAgent', side: 'BUY', confidence: 0.8, reasoning: 'bullish' })),
      classifyVote(ev({ agent: 'QuantEngine', side: 'SELL', confidence: 0.8, reasoning: 'bearish' })),
    ];
    const result = computeShadowConsensus(votes, weights, threshold);
    expect(result.finalDecision).toBe('HOLD');
    expect(result.reasonCode).toBe('INSUFFICIENT_CONVICTION');
  });

  it('5. MODEL_UNCERTAIN: a low-margin debate contributes uncertainty, not a fabricated strong HOLD', () => {
    const debateMargin = computeDebateMarginFromResults([
      { decision: 'HOLD', confidence: 52, status: 'success' },
      { decision: 'BUY', confidence: 48, status: 'success' },
    ]);
    expect(debateMargin.evidenceState).toBe('UNCERTAIN');
    expect(debateMargin.shadowConfidence).toBeLessThan(0.3);
  });

  it('6. Multiple unavailable agents: all excluded, decision rests only on usable evidence', () => {
    const votes = [
      classifyVote(ev({ agent: 'FundamentalAgent', side: 'HOLD', confidence: 0.5, reasoning: 'DATA_UNAVAILABLE: rate limit exhausted' })),
      classifyVote(ev({ agent: 'MacroAgent', side: 'HOLD', confidence: 0.4, reasoning: 'DATA_UNAVAILABLE: rate limit exhausted' })),
      classifyVote(ev({ agent: 'TechnicalAgent', side: 'BUY', confidence: 0.8, reasoning: 'strong trend' })),
    ];
    const result = computeShadowConsensus(votes, weights, threshold);
    expect(result.excludedAgents).toHaveLength(2);
    expect(result.finalDecision).toBe('BUY');
  });

  it('7. Unanimous BUY: clears threshold cleanly', () => {
    const votes = [
      classifyVote(ev({ agent: 'TechnicalAgent', side: 'BUY', confidence: 0.85, reasoning: 'a' })),
      classifyVote(ev({ agent: 'QuantEngine', side: 'BUY', confidence: 0.85, reasoning: 'b' })),
      classifyVote(ev({ agent: 'KronosEngine', side: 'BUY', confidence: 0.85, reasoning: 'c' })),
    ];
    const result = computeShadowConsensus(votes, weights, threshold);
    expect(result.finalDecision).toBe('BUY');
    expect(result.aggregateConfidence).toBeGreaterThan(threshold);
  });

  it('8. Unanimous HOLD: genuine no-edge across all agents, correctly rejected without fabricated conviction', () => {
    const votes = [
      classifyVote(ev({ agent: 'TechnicalAgent', side: 'HOLD', confidence: 0.5, reasoning: 'range-bound' })),
      classifyVote(ev({ agent: 'QuantEngine', side: 'HOLD', confidence: 0.5, reasoning: 'no regime edge' })),
    ];
    const result = computeShadowConsensus(votes, weights, threshold);
    expect(result.finalDecision).toBe('HOLD');
  });

  it('9. Strong bearish veto: real, high-confidence opposing evidence should dominate even a single BUY vote', () => {
    const votes = [
      classifyVote(ev({ agent: 'TechnicalAgent', side: 'BUY', confidence: 0.5, reasoning: 'weak breakout' })),
      classifyVote(ev({ agent: 'ConsensusDebate', side: 'SELL', confidence: 0.95, reasoning: 'Multi-Model Debate Concluded: SELL (Based on 2 successful models; 0 failed)' })),
    ];
    const result = computeShadowConsensus(votes, weights, threshold);
    expect(result.bearishEvidence).toBeGreaterThan(result.bullishEvidence);
  });

  it('10. AI provider partial failure: one model failed, one succeeded - reduced but non-zero evidence weight', () => {
    const debateMargin = computeDebateMarginFromResults([
      { decision: 'SELL', confidence: 90, status: 'success' },
      { status: 'error' },
    ]);
    expect(debateMargin.successCount).toBe(1);
    expect(debateMargin.attemptedCount).toBe(2);
    expect(debateMargin.shadowConfidence).toBeGreaterThan(0);
    // Completeness discount: a 1-of-2 result must be weaker evidence than the identical decision from 2-of-2.
    const fullDebate = computeDebateMarginFromResults([
      { decision: 'SELL', confidence: 90, status: 'success' },
      { decision: 'SELL', confidence: 90, status: 'success' },
    ]);
    expect(debateMargin.shadowConfidence).toBeLessThan(fullDebate.shadowConfidence);
  });
});
