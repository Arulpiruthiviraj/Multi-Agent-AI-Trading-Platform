/**
 * selectionPoolBreakdown.test.ts — Part 21 (NO_ELIGIBLE_STRATEGY explainability).
 *
 * When Quant returns NO_ELIGIBLE_STRATEGY, the persisted DESK_NO_TRADE evidence must
 * name exactly where each strategy was excluded: trigger != eligibility. This test
 * covers the pure breakdown builder (the production emit site in QuantSignalAgent
 * passes the live chain through it unchanged).
 */
import { describe, it, expect } from 'vitest';
import { buildSelectionPoolBreakdown } from '../services/QuantSignalAgent';

const ev = (strategy: string, triggerMet: boolean) => ({ strategy, triggerMet });
const id = (strategy: string) => ({ strategy });

describe('buildSelectionPoolBreakdown', () => {
  it('names each exclusion stage: triggered strategies excluded by focus/adaptive/quarantine/economics', () => {
    const out = buildSelectionPoolBreakdown({
      // MA_CROSSOVER triggers (the SNOW shape) but is outside the focus pool.
      strategyEvaluations: [ev('MA_CROSSOVER', true), ev('MOMENTUM_BREAKOUT', true), ev('MEAN_REVERSION', false)],
      focusedEvaluations: [id('MOMENTUM_BREAKOUT'), id('MEAN_REVERSION')],
      adaptedEvaluations: [id('MOMENTUM_BREAKOUT')],
      emissionEligibleEvaluations: [],
      economicsRefusal: null,
    });
    expect(out.evaluated).toEqual(['MA_CROSSOVER', 'MOMENTUM_BREAKOUT', 'MEAN_REVERSION']);
    expect(out.triggered).toEqual(['MA_CROSSOVER', 'MOMENTUM_BREAKOUT']);
    expect(out.excludedByFocus).toEqual(['MA_CROSSOVER']); // trigger != eligibility
    expect(out.excludedByAdaptiveRegime).toEqual(['MEAN_REVERSION']);
    expect(out.excludedByQuarantine).toEqual(['MOMENTUM_BREAKOUT']);
    expect(out.economicsRefusal).toBeNull();
    expect(out.remaining).toEqual([]);
  });

  it('records the economics refusal when a qualifying idea was refused by EV/R:R', () => {
    const out = buildSelectionPoolBreakdown({
      strategyEvaluations: [ev('MOMENTUM_BREAKOUT', true)],
      focusedEvaluations: [id('MOMENTUM_BREAKOUT')],
      adaptedEvaluations: [id('MOMENTUM_BREAKOUT')],
      emissionEligibleEvaluations: [id('MOMENTUM_BREAKOUT')],
      economicsRefusal: 'EXPECTED_VALUE_TOO_LOW',
    });
    expect(out.triggered).toEqual(['MOMENTUM_BREAKOUT']);
    expect(out.excludedByFocus).toEqual([]);
    expect(out.excludedByAdaptiveRegime).toEqual([]);
    expect(out.excludedByQuarantine).toEqual([]);
    expect(out.economicsRefusal).toBe('EXPECTED_VALUE_TOO_LOW');
    expect(out.remaining).toEqual(['MOMENTUM_BREAKOUT']);
  });

  it('is bounded: strategy-ID lists only, no evaluation payloads leak through', () => {
    const out = buildSelectionPoolBreakdown({
      strategyEvaluations: [ev('A', true)],
      focusedEvaluations: [id('A')],
      adaptedEvaluations: [id('A')],
      emissionEligibleEvaluations: [id('A')],
      economicsRefusal: null,
    });
    const json = JSON.stringify(out);
    expect(json.length).toBeLessThan(2000);
    for (const list of [out.evaluated, out.triggered, out.remaining]) {
      for (const s of list) expect(typeof s).toBe('string');
    }
  });
});
