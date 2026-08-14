import { describe, it, expect } from 'vitest';
import { evaluateAll, bestStrategyIdea, ALL_STRATEGIES } from './StrategyEngine';
import { baseFixture } from './testHelpers';
import { StrategyEvaluation } from './types';

describe('StrategyEngine.evaluateAll', () => {
  it('runs all 5 real strategies and sorts results by setupScore descending', () => {
    const ctx = baseFixture();
    // A neutral fixture: every strategy's own conditions mostly fail, but each still returns a
    // real (not thrown) evaluation with its own honestly-low setupScore.
    const results = evaluateAll(ctx);

    expect(results).toHaveLength(5);
    expect(new Set(results.map(r => r.strategy))).toEqual(new Set(['MOMENTUM_BREAKOUT', 'PULLBACK_CONTINUATION', 'MEAN_REVERSION', 'TREND_FOLLOWING', 'RANGE_REVERSION']));
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].setupScore).toBeGreaterThanOrEqual(results[i].setupScore);
    }
  });

  it('discounts (does not zero) a strategy\'s confidence when evaluated outside its own applicable regime', () => {
    const ctx = baseFixture();
    // Force a full-strength Mean Reversion setup (applicableRegimes: ['SIDEWAYS_RANGE']) while the
    // CURRENT regime is BULLISH_TREND - a real regime/strategy mismatch.
    ctx.regime.regime = 'BULLISH_TREND'; // mismatched vs Mean Reversion's own applicableRegimes
    ctx.regime.marketStructure = 'RANGING';
    ctx.momentum.rsi = 25;
    ctx.volatility.keltner = { middle: 100, upper: 105, lower: 95 };
    ctx.currentPrice = 94;
    ctx.momentum.stochasticRSI = 10;
    ctx.priceAction.candlestick = 'HAMMER';

    const results = evaluateAll(ctx);
    const meanReversionResult = results.find(r => r.strategy === 'MEAN_REVERSION')!;

    // Mean Reversion's own raw confidence (setupScore/100) would be less than 1.0 here anyway
    // (the ranging-regime condition itself fails against BULLISH_TREND), but the regime-mismatch
    // discount is still real and separately verifiable: recompute what the raw evaluate() would
    // have returned and confirm the engine's blended confidence is materially lower than it.
    const raw = ALL_STRATEGIES.find(s => s.id === 'MEAN_REVERSION')!.evaluate(ctx);
    expect(meanReversionResult.confidence).toBeLessThan(raw.confidence + 0.001);
    expect(meanReversionResult.confidence).toBeCloseTo(Math.round(raw.confidence * 0.5 * 100) / 100, 5);
  });

  it('does not discount a strategy evaluated inside its own applicable regime', () => {
    const ctx = baseFixture();
    ctx.regime.regime = 'SIDEWAYS_RANGE'; // matches Mean Reversion's applicableRegimes
    ctx.regime.marketStructure = 'RANGING';
    ctx.momentum.rsi = 25;
    ctx.volatility.keltner = { middle: 100, upper: 105, lower: 95 };
    ctx.currentPrice = 94;
    ctx.momentum.stochasticRSI = 10;
    ctx.priceAction.candlestick = 'HAMMER';

    const results = evaluateAll(ctx);
    const meanReversionResult = results.find(r => r.strategy === 'MEAN_REVERSION')!;
    const raw = ALL_STRATEGIES.find(s => s.id === 'MEAN_REVERSION')!.evaluate(ctx);

    expect(meanReversionResult.confidence).toBe(raw.confidence);
  });
});

describe('StrategyEngine.bestStrategyIdea', () => {
  it('returns null when no strategy clears the minimum confidence bar', () => {
    const weak: StrategyEvaluation[] = [
      { strategy: 'MOMENTUM_BREAKOUT', side: 'BUY', setupScore: 40, confidence: 0.4, conditionsMet: [], conditionsFailed: [], contradictions: [], invalidationConditions: [], stop: { price: null, basis: 'x' }, target: { price: null, basis: 'x' }, applicableRegimes: ['BULLISH_TREND'] },
    ];
    expect(bestStrategyIdea(weak)).toBeNull();
  });

  it('picks the highest-setupScore eligible strategy and formats a real, evidence-citing reasoning string', () => {
    // bestStrategyIdea() relies on its input already being sorted by setupScore descending (the
    // contract evaluateAll() guarantees) - pre-sorted here to match that real contract, exactly as
    // evaluateAll() itself would hand it off.
    const evaluations: StrategyEvaluation[] = [
      { strategy: 'MOMENTUM_BREAKOUT', side: 'SELL', setupScore: 90, confidence: 0.9, conditionsMet: ['x', 'y'], conditionsFailed: [], contradictions: ['z'], invalidationConditions: [], stop: { price: null, basis: 'x' }, target: { price: null, basis: 'x' }, applicableRegimes: ['BEARISH_TREND'] },
      { strategy: 'TREND_FOLLOWING', side: 'BUY', setupScore: 65, confidence: 0.65, conditionsMet: ['a'], conditionsFailed: ['b'], contradictions: [], invalidationConditions: [], stop: { price: null, basis: 'x' }, target: { price: null, basis: 'x' }, applicableRegimes: ['BULLISH_TREND'] },
    ];

    const idea = bestStrategyIdea(evaluations);

    expect(idea).not.toBeNull();
    expect(idea!.strategy).toBe('MOMENTUM_BREAKOUT'); // the pre-sorted first (highest-setupScore) eligible entry
    expect(idea!.side).toBe('SELL');
    expect(idea!.confidence).toBe(0.9);
    expect(idea!.reasoning).toContain('MOMENTUM_BREAKOUT');
    expect(idea!.reasoning).toContain('setupScore 90');
    expect(idea!.reasoning).toContain('Contradictions: z');
  });
});
