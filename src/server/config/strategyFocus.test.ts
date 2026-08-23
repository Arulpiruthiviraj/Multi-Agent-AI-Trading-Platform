import { describe, it, expect } from 'vitest';
import {
  strategyFocusConfig,
  normalizeStrategyFocus,
  filterEvaluationsForStrategyFocus,
  isAdaptiveStrategyFocus,
  preferredStrategiesForRegime,
  applyAdaptiveRegimePreference,
  selectEvaluationsForAdaptiveRegime,
} from './strategyFocus';
import { tradingSafety } from './tradingSafety';

describe('strategyFocus', () => {
  it('defaults to ADAPTIVE_MULTI_STRATEGY and matches tradingSafety.defaultStrategyFocus', () => {
    expect(strategyFocusConfig.defaultFocus).toBe('ADAPTIVE_MULTI_STRATEGY');
    expect(tradingSafety.defaultStrategyFocus).toBe('ADAPTIVE_MULTI_STRATEGY');
    expect(tradingSafety.defaultStrategyFocus).toBe(strategyFocusConfig.defaultFocus);
    expect(isAdaptiveStrategyFocus(null)).toBe(true);
    expect(normalizeStrategyFocus('Momentum Focus')).toBe('ADAPTIVE_MULTI_STRATEGY');
    expect(normalizeStrategyFocus('ALL_CORE')).toBe('ADAPTIVE_MULTI_STRATEGY');
  });

  it('maps legacy UI labels to canonical ids', () => {
    expect(normalizeStrategyFocus('Momentum & Breakout')).toBe('MOMENTUM_BREAKOUT');
    expect(normalizeStrategyFocus('Mean Reversion')).toBe('MEAN_REVERSION');
  });

  it('adaptive focus does not filter CORE evaluations before regime routing', () => {
    const rows = [
      { strategy: 'MOMENTUM_BREAKOUT', setupScore: 90 },
      { strategy: 'MEAN_REVERSION', setupScore: 80 },
      { strategy: 'TREND_FOLLOWING', setupScore: 70 },
    ];
    expect(filterEvaluationsForStrategyFocus(rows, 'ADAPTIVE_MULTI_STRATEGY')).toEqual(rows);
  });

  it('manual momentum bias keeps breakout family only', () => {
    const rows = [
      { strategy: 'MOMENTUM_BREAKOUT', setupScore: 90 },
      { strategy: 'MEAN_REVERSION', setupScore: 95 },
      { strategy: 'PULLBACK_CONTINUATION', setupScore: 88 },
    ];
    const filtered = filterEvaluationsForStrategyFocus(rows, 'MOMENTUM_BREAKOUT');
    expect(filtered.map((r) => r.strategy).sort()).toEqual(['MOMENTUM_BREAKOUT', 'PULLBACK_CONTINUATION']);
  });

  it('Option B: SIDEWAYS_RANGE hard-routes to mean-reversion CORE only', () => {
    expect(preferredStrategiesForRegime('SIDEWAYS_RANGE')).toEqual(
      expect.arrayContaining(['MEAN_REVERSION', 'RANGE_REVERSION']),
    );
    const rows = [
      { strategy: 'MOMENTUM_BREAKOUT', setupScore: 95, confidence: 0.9 },
      { strategy: 'MEAN_REVERSION', setupScore: 70, confidence: 0.7 },
      { strategy: 'RANGE_REVERSION', setupScore: 65, confidence: 0.65 },
    ];
    const routed = selectEvaluationsForAdaptiveRegime(rows, 'ADAPTIVE_MULTI_STRATEGY', 'SIDEWAYS_RANGE', 'NORMAL');
    expect(routed.map((r) => r.strategy).sort()).toEqual(['MEAN_REVERSION', 'RANGE_REVERSION']);
    expect(routed.every((r) => r.confidence >= 0.65)).toBe(true);
  });

  it('Option B: BULLISH_TREND routes to momentum/pullback/trend', () => {
    const rows = [
      { strategy: 'MEAN_REVERSION', setupScore: 99, confidence: 0.9 },
      { strategy: 'MOMENTUM_BREAKOUT', setupScore: 50, confidence: 0.5 },
      { strategy: 'TREND_FOLLOWING', setupScore: 40, confidence: 0.4 },
      { strategy: 'PULLBACK_CONTINUATION', setupScore: 45, confidence: 0.45 },
    ];
    const routed = selectEvaluationsForAdaptiveRegime(rows, 'ADAPTIVE_MULTI_STRATEGY', 'BULLISH_TREND', 'NORMAL');
    expect(routed.map((r) => r.strategy).sort()).toEqual([
      'MOMENTUM_BREAKOUT',
      'PULLBACK_CONTINUATION',
      'TREND_FOLLOWING',
    ]);
  });

  it('Option B: HIGH volatility overlays momentum/trend CORE ids', () => {
    const rows = [
      { strategy: 'MEAN_REVERSION', setupScore: 90, confidence: 0.8 },
      { strategy: 'MOMENTUM_BREAKOUT', setupScore: 50, confidence: 0.5 },
    ];
    const routed = selectEvaluationsForAdaptiveRegime(rows, 'ADAPTIVE_MULTI_STRATEGY', 'SIDEWAYS_RANGE', 'HIGH');
    expect(routed.map((r) => r.strategy)).toEqual(['MOMENTUM_BREAKOUT']);
  });

  it('soft-boost helper still ranks preferred first when used alone', () => {
    const rows = [
      { strategy: 'MOMENTUM_BREAKOUT', setupScore: 80 },
      { strategy: 'MEAN_REVERSION', setupScore: 70 },
    ];
    const adapted = applyAdaptiveRegimePreference(rows, 'ADAPTIVE_MULTI_STRATEGY', 'SIDEWAYS_RANGE', 'NORMAL');
    expect(adapted[0].strategy).toBe('MEAN_REVERSION');
  });

  it('manual focus ignores adaptive regime routing', () => {
    const rows = [
      { strategy: 'MEAN_REVERSION', setupScore: 50, confidence: 0.5 },
      { strategy: 'MOMENTUM_BREAKOUT', setupScore: 90, confidence: 0.9 },
    ];
    expect(selectEvaluationsForAdaptiveRegime(rows, 'MEAN_REVERSION', 'BULLISH_TREND', 'NORMAL')).toEqual(rows);
  });
});
