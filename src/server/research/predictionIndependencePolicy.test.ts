import { describe, it, expect } from 'vitest';
import { independenceClusterGapMs, isExcludedFromWeightLearning, secondaryGroupKey } from './predictionIndependencePolicy';
import { tradingSafety } from '../config/tradingSafety';
import { agentWeightConfig } from '../config/agentWeights';

describe('independenceClusterGapMs', () => {
  it('uses the shorter Kronos-specific horizon for KronosEngine', () => {
    expect(independenceClusterGapMs('KronosEngine')).toBe(tradingSafety.kronosEvaluationHorizonMs);
  });

  it('uses the generic evaluation horizon for every other agent', () => {
    expect(independenceClusterGapMs('TechnicalAgent')).toBe(tradingSafety.evaluationHorizonMs);
    expect(independenceClusterGapMs('QuantEngine')).toBe(tradingSafety.evaluationHorizonMs);
    expect(independenceClusterGapMs('NewsAgent')).toBe(tradingSafety.evaluationHorizonMs);
  });
});

describe('isExcludedFromWeightLearning', () => {
  it('excludes the configured risk-exit agent (not directional alpha)', () => {
    expect(isExcludedFromWeightLearning(agentWeightConfig.riskExitAgent)).toBe(true);
  });

  it('does not exclude directional-idea agents', () => {
    expect(isExcludedFromWeightLearning('TechnicalAgent')).toBe(false);
    expect(isExcludedFromWeightLearning('KronosEngine')).toBe(false);
    expect(isExcludedFromWeightLearning('QuantEngine')).toBe(false);
  });
});

describe('secondaryGroupKey', () => {
  it('extracts the real strategy id from QuantEngine reasoning text', () => {
    const reasoning = 'QuantEngine/TREND_FOLLOWING: setupScore 0.8 (3/4 conditions met), confidence 0.75. Met: x; y.';
    expect(secondaryGroupKey('QuantEngine', reasoning)).toBe('TREND_FOLLOWING');
  });

  it('returns COLD_START_BOOTSTRAP for the regime-only bootstrap idea, never mixed with a real strategy id', () => {
    const reasoning = 'QuantEngine: BULLISH_TREND regime... Cold-start bootstrap: TREND_FOLLOWING has zero real closed live trades yet, so no EV/stop/target backs this idea - operator-enabled via QUANT_COLD_START_BOOTSTRAP_ENABLED.';
    expect(secondaryGroupKey('QuantEngine', reasoning)).toBe('COLD_START_BOOTSTRAP');
  });

  it('returns null for non-QuantEngine agents and for missing/unparseable reasoning', () => {
    expect(secondaryGroupKey('TechnicalAgent', 'QuantEngine/TREND_FOLLOWING: whatever')).toBeNull();
    expect(secondaryGroupKey('QuantEngine', null)).toBeNull();
    expect(secondaryGroupKey('QuantEngine', 'no strategy pattern here')).toBeNull();
  });
});
