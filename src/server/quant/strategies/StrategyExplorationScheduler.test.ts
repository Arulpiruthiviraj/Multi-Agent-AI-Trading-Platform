import { describe, it, expect, beforeEach } from 'vitest';
import { selectWithBoundedExploration, resetStrategyExplorationStateForTests } from './StrategyExplorationScheduler';
import type { StrategyEvaluation } from './types';

function makeEval(strategy: string, setupScore: number, confidence: number): StrategyEvaluation {
  return {
    strategy, side: 'BUY', setupScore, confidence,
    conditionsMet: [], conditionsFailed: [], contradictions: [], invalidationConditions: [],
    stop: { price: null, basis: 'test' }, target: { price: null, basis: 'test' },
    applicableRegimes: ['BULLISH_TREND'],
  };
}

describe('StrategyExplorationScheduler', () => {
  beforeEach(() => {
    resetStrategyExplorationStateForTests();
  });

  it('promotes a starved-but-qualifying strategy over the perpetual highest-setupScore winner (real MOMENTUM_BREAKOUT scenario: rank 8-17 of 21, confidence 0.5, still above the 0.6 bar is NOT required for the dominant winner to count as starved-candidate-eligible - only the promoted candidate itself must clear the bar)', () => {
    const evaluations = [
      makeEval('OSCILLATOR_MOMENTUM', 100, 1.0),
      makeEval('MOMENTUM_BREAKOUT', 50, 0.65),
      makeEval('MEAN_REVERSION', 10, 0.2),
    ];
    const result = selectWithBoundedExploration(evaluations, 1_000_000);
    expect(result[0].strategy).toBe('MOMENTUM_BREAKOUT');
    // Nothing is dropped - the rest of the list is preserved, just reordered.
    expect(result.map((e) => e.strategy).sort()).toEqual(['MEAN_REVERSION', 'MOMENTUM_BREAKOUT', 'OSCILLATOR_MOMENTUM'].sort());
  });

  it('never promotes a strategy below MIN_STRATEGY_CONFIDENCE_TO_TRADE (0.6) - real evidence never invents confidence', () => {
    const evaluations = [
      makeEval('OSCILLATOR_MOMENTUM', 100, 1.0),
      makeEval('MOMENTUM_BREAKOUT', 50, 0.25), // real evaluation, but below the trade bar
    ];
    const result = selectWithBoundedExploration(evaluations, 1_000_000);
    expect(result[0].strategy).toBe('OSCILLATOR_MOMENTUM');
  });

  it('does not reorder when fewer than 2 strategies clear the confidence bar - nothing to explore among', () => {
    const evaluations = [makeEval('OSCILLATOR_MOMENTUM', 100, 1.0)];
    const result = selectWithBoundedExploration(evaluations, 1_000_000);
    expect(result).toBe(evaluations);
  });

  it('is rate-limited system-wide: a second promotion within strategyExplorationMinIntervalMs (900000ms) does not fire even for a different symbol/strategy pair', () => {
    const evalsA = [makeEval('OSCILLATOR_MOMENTUM', 100, 1.0), makeEval('MOMENTUM_BREAKOUT', 50, 0.65)];
    const first = selectWithBoundedExploration(evalsA, 1_000_000);
    expect(first[0].strategy).toBe('MOMENTUM_BREAKOUT');

    const evalsB = [makeEval('OSCILLATOR_MOMENTUM', 100, 1.0), makeEval('RANGE_REVERSION', 40, 0.62)];
    const second = selectWithBoundedExploration(evalsB, 1_000_000 + 60_000); // 1 minute later, well under the 15-minute global rate limit
    expect(second[0].strategy).toBe('OSCILLATOR_MOMENTUM'); // rate-limited - no promotion this cycle
  });

  it('re-promotes the SAME strategy again once its own cooldown (86400000ms) has elapsed, after the global rate limit also clears', () => {
    const evals = [makeEval('OSCILLATOR_MOMENTUM', 100, 1.0), makeEval('MOMENTUM_BREAKOUT', 50, 0.65)];
    const first = selectWithBoundedExploration(evals, 1_000_000);
    expect(first[0].strategy).toBe('MOMENTUM_BREAKOUT');

    const tooSoon = selectWithBoundedExploration(evals, 1_000_000 + 86_400_000 - 1);
    expect(tooSoon[0].strategy).toBe('OSCILLATOR_MOMENTUM'); // cooldown not yet elapsed

    const afterCooldown = selectWithBoundedExploration(evals, 1_000_000 + 86_400_000 + 1);
    expect(afterCooldown[0].strategy).toBe('MOMENTUM_BREAKOUT');
  });

  it('rotates fairly to whichever eligible strategy has gone longest without a turn, never the same one twice in a row when another is equally starved', () => {
    const evals1 = [makeEval('OSCILLATOR_MOMENTUM', 100, 1.0), makeEval('MOMENTUM_BREAKOUT', 50, 0.65), makeEval('RANGE_REVERSION', 45, 0.62)];
    const first = selectWithBoundedExploration(evals1, 1_000_000);
    expect(first[0].strategy).toBe('MOMENTUM_BREAKOUT'); // first starved candidate in setupScore order

    // Same tick composition, well past the global rate limit and MOMENTUM_BREAKOUT's own cooldown
    // would both allow it again, but RANGE_REVERSION has now gone even longer without a turn is not
    // true here (MOMENTUM_BREAKOUT was just promoted) - so the natural top should win until the
    // rate limit clears, then MOMENTUM_BREAKOUT is cooling down and RANGE_REVERSION is next in line.
    const secondTick = selectWithBoundedExploration(evals1, 1_000_000 + 900_000 + 1);
    expect(secondTick[0].strategy).toBe('RANGE_REVERSION');
  });

  it('is a complete no-op when disabled via config (verified against the real config module, not a mock)', async () => {
    const { quantThresholds } = await import('../../config/quantThresholds');
    const original = quantThresholds.strategyExplorationEnabled;
    (quantThresholds as any).strategyExplorationEnabled = false;
    try {
      const evals = [makeEval('OSCILLATOR_MOMENTUM', 100, 1.0), makeEval('MOMENTUM_BREAKOUT', 50, 0.65)];
      const result = selectWithBoundedExploration(evals, 5_000_000);
      expect(result).toBe(evals); // exact same reference - zero transformation
    } finally {
      (quantThresholds as any).strategyExplorationEnabled = original;
    }
  });
});
