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

  it('extracts the real underlying strategy from a bootstrap idea, honestly suffixed - real fix (Phase 10, 2026-08-31): every QuantEngine idea to date has gone through this exact path (zero organic closed trades), so collapsing them all into one generic bucket meant no named strategy could ever accumulate its own attributable evidence', () => {
    const reasoning = 'QuantEngine: BULLISH_TREND regime (trendStrength 0.8, marketStructure HH_HL, volatility NORMAL), confidence 0.70 from real multi-feature agreement. Cold-start bootstrap: TREND_FOLLOWING is COLD_START (zero real closed trades), so no EV/stop/target backs this idea - operator-enabled via QUANT_COLD_START_BOOTSTRAP_ENABLED.';
    expect(secondaryGroupKey('QuantEngine', reasoning)).toBe('TREND_FOLLOWING__COLD_START_BOOTSTRAP');
  });

  it('extracts the real strategy from a WARMING_UP bootstrap idea the same way', () => {
    const reasoning = 'Cold-start bootstrap: MEAN_REVERSION is WARMING_UP (3 real closed trades, below the 20-trade trust threshold), so no EV/stop/target backs this idea - operator-enabled via QUANT_COLD_START_BOOTSTRAP_ENABLED.';
    expect(secondaryGroupKey('QuantEngine', reasoning)).toBe('MEAN_REVERSION__COLD_START_BOOTSTRAP');
  });

  it('falls back to the generic COLD_START_BOOTSTRAP key when the bootstrap phrase is present but the strategy name cannot be parsed (fail-safe, never throws)', () => {
    const reasoning = 'Cold-start bootstrap: something unparseable happened here.';
    expect(secondaryGroupKey('QuantEngine', reasoning)).toBe('COLD_START_BOOTSTRAP');
  });

  it('returns null for non-QuantEngine agents and for missing/unparseable reasoning', () => {
    expect(secondaryGroupKey('TechnicalAgent', 'QuantEngine/TREND_FOLLOWING: whatever')).toBeNull();
    expect(secondaryGroupKey('QuantEngine', null)).toBeNull();
    expect(secondaryGroupKey('QuantEngine', 'no strategy pattern here')).toBeNull();
  });
});
