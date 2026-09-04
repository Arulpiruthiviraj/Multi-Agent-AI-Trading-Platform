import { describe, it, expect } from 'vitest';
import { independenceClusterGapMs, isExcludedFromWeightLearning, secondaryGroupKey, resolveEvaluationHorizonMs } from './predictionIndependencePolicy';
import { tradingSafety } from '../config/tradingSafety';
import { agentWeightConfig } from '../config/agentWeights';
import { evaluationHorizons } from '../config/evaluationHorizons';

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

describe('resolveEvaluationHorizonMs (evaluation-horizon-mismatch remediation, 2026-09-04)', () => {
  it('uses the configured longer horizon for FundamentalAgent and MacroAgent instead of the generic default', () => {
    expect(resolveEvaluationHorizonMs('FundamentalAgent', null)).toBe(evaluationHorizons.byAgentName.FundamentalAgent);
    expect(resolveEvaluationHorizonMs('MacroAgent', null)).toBe(evaluationHorizons.byAgentName.MacroAgent);
    expect(evaluationHorizons.byAgentName.FundamentalAgent).toBeGreaterThan(tradingSafety.evaluationHorizonMs);
    expect(evaluationHorizons.byAgentName.MacroAgent).toBeGreaterThan(evaluationHorizons.byAgentName.FundamentalAgent);
  });

  it('falls back to the generic default for agents with no override (TechnicalAgent, NewsAgent - deliberately not overridden)', () => {
    expect(resolveEvaluationHorizonMs('TechnicalAgent', null)).toBe(tradingSafety.evaluationHorizonMs);
    expect(resolveEvaluationHorizonMs('NewsAgent', null)).toBe(tradingSafety.evaluationHorizonMs);
  });

  it('resolves QuantEngine to its real strategy-specific horizon, not the generic default', () => {
    const trendFollowing = 'QuantEngine/TREND_FOLLOWING: setupScore 0.8 (3/4 conditions met), confidence 0.75.';
    expect(resolveEvaluationHorizonMs('QuantEngine', trendFollowing)).toBe(evaluationHorizons.byQuantStrategyId.TREND_FOLLOWING);

    const meanReversion = 'QuantEngine/MEAN_REVERSION: setupScore 0.7, confidence 0.65.';
    expect(resolveEvaluationHorizonMs('QuantEngine', meanReversion)).toBe(evaluationHorizons.byQuantStrategyId.MEAN_REVERSION);

    // The two resolve to genuinely different horizons - proving this isn't a no-op mapping.
    expect(evaluationHorizons.byQuantStrategyId.TREND_FOLLOWING).not.toBe(evaluationHorizons.byQuantStrategyId.MEAN_REVERSION);
  });

  it('strips the __COLD_START_BOOTSTRAP suffix before lookup - a strategy\'s real horizon does not change because it is still in cold-start', () => {
    const bootstrap = 'Cold-start bootstrap: TREND_FOLLOWING is COLD_START (zero real closed trades), so no EV/stop/target backs this idea.';
    expect(resolveEvaluationHorizonMs('QuantEngine', bootstrap)).toBe(evaluationHorizons.byQuantStrategyId.TREND_FOLLOWING);
  });

  it('falls back to the generic default for an unparseable or unknown QuantEngine strategy id, never throws', () => {
    expect(resolveEvaluationHorizonMs('QuantEngine', 'no strategy pattern here')).toBe(tradingSafety.evaluationHorizonMs);
    expect(resolveEvaluationHorizonMs('QuantEngine', null)).toBe(tradingSafety.evaluationHorizonMs);
    expect(resolveEvaluationHorizonMs('QuantEngine', 'QuantEngine/SOME_FUTURE_STRATEGY_NOT_YET_CONFIGURED: x')).toBe(tradingSafety.evaluationHorizonMs);
  });
});
