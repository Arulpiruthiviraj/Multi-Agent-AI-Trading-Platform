/**
 * Degenerate-input tests (2026-10-04 quant repair pass).
 *
 * A missing defining input must never become a directional strategy signal. For every
 * degenerate mutation below, each of the 21 strategies must (a) not throw, and (b) never
 * return an ACTIONABLE evaluation (triggerMet === true AND confidence >= trade bar).
 *
 * Baseline established first: on the neutral baseFixture() (everything flat/neutral),
 * zero strategies are actionable - so any actionable result under a degenerate mutation
 * would be a real fail-open defect, not fixture noise.
 */
import { describe, it, expect } from 'vitest';
import { baseFixture } from './testHelpers';
import {
  MIN_STRATEGY_CONFIDENCE_TO_TRADE,
  CORE_STRATEGIES,
  EXPERIMENTAL_STRATEGIES,
} from './StrategyEngine';
import type { StrategyContext, StrategyDefinition } from './types';

const ALL: StrategyDefinition[] = [...CORE_STRATEGIES, ...EXPERIMENTAL_STRATEGIES];

type Mutation = (ctx: StrategyContext) => void;

const MUTATIONS: Array<[string, Mutation]> = [
  ['null ATR', (ctx) => { (ctx.volatility as any).atr = null; }],
  ['null DMI', (ctx) => { (ctx.trend as any).dmi = null; }],
  ['null ADX inside DMI', (ctx) => { (ctx.trend.dmi as any) = { plusDI: 20, minusDI: 20, adx: null }; }],
  ['null relative strength (SPY + sector)', (ctx) => {
    (ctx.marketContext as any).relativeStrengthVsSPY = null;
    (ctx.marketContext as any).relativeStrengthVsSector = null;
    (ctx.marketContext.sector as any) = { name: null, etf: null, trend: null };
  }],
  ['null opening range', (ctx) => {
    (ctx.supportResistance as any).openingRange = { available: false, reason: 'degenerate test', data: null };
  }],
  ['null Keltner channels', (ctx) => { (ctx.volatility as any).keltner = null; }],
  ['null prior channel (Donchian)', (ctx) => { (ctx.supportResistance as any).priorChannel20 = null; }],
  ['null previous-day levels', (ctx) => { (ctx.supportResistance as any).previousDay = null; }],
  ['missing SMC context', (ctx) => { delete (ctx as any).smc; }],
  ['SMC context present but empty', (ctx) => { (ctx as any).smc = {}; }],
  ['NaN currentPrice', (ctx) => { ctx.currentPrice = NaN; }],
  ['NaN ATR', (ctx) => { (ctx.volatility as any).atr = NaN; }],
  ['Infinity RSI', (ctx) => { (ctx.momentum as any).rsi = Infinity; }],
  ['null RSI', (ctx) => { (ctx.momentum as any).rsi = null; }],
  ['null MACD', (ctx) => { (ctx.momentum as any).macd = null; }],
  ['null VWAP', (ctx) => { (ctx.volume as any).vwap = null; }],
  ['null moving averages', (ctx) => { (ctx.trend as any).movingAverages = null; }],
  ['null Bollinger width', (ctx) => { (ctx.volatility as any).bollingerBandWidthPct = null; }],
  ['zero volume profile', (ctx) => {
    (ctx.volume as any).volumeSMA20 = 0;
    (ctx.volume as any).relativeVolume = 0;
  }],
  ['insufficient-data regime flag', (ctx) => { (ctx.regime as any).insufficientData = true; }],
];

describe('evaluateAll strategy isolation (defense-in-depth)', () => {
  it('a throwing strategy fails closed without aborting other strategies', async () => {
    const engine = await import('./StrategyEngine');
    const { meanReversion } = await import('./meanReversion');
    const original = meanReversion.evaluate;
    // Simulate a future degenerate shape no per-strategy guard anticipates.
    (meanReversion as any).evaluate = () => { throw new Error('simulated unforeseen degenerate input'); };
    try {
      const evaluations = engine.evaluateAll(baseFixture());
      // All other strategies still evaluated.
      expect(evaluations.length).toBe(engine.CORE_STRATEGIES.length);
      const failed = evaluations.find((e) => e.strategy === 'MEAN_REVERSION')!;
      expect(failed.triggerMet).toBe(false);
      expect(failed.confidence).toBeLessThan(engine.MIN_STRATEGY_CONFIDENCE_TO_TRADE);
      expect(failed.conditionsFailed.join(' ')).toMatch(/fail-closed/i);
      // And the throwing strategy can never become the best idea.
      const bestMeanReversion = engine.bestStrategyIdea(evaluations.filter((e) => e.strategy === 'MEAN_REVERSION'));
      expect(bestMeanReversion).toBeNull();
    } finally {
      (meanReversion as any).evaluate = original;
    }
  });
});
describe('degenerate strategy inputs fail closed', () => {
  it('baseline: no strategy is actionable on the neutral fixture', () => {
    const ctx = baseFixture();
    const actionable = ALL.filter((s) => {
      const e = s.evaluate(ctx);
      return e.triggerMet === true && e.confidence >= MIN_STRATEGY_CONFIDENCE_TO_TRADE;
    });
    expect(actionable.map((s) => s.id)).toEqual([]);
  });

  for (const [name, mutate] of MUTATIONS) {
    describe(name, () => {
      for (const strategy of ALL) {
        it(`${strategy.id}: does not throw and is not actionable`, () => {
          const ctx = baseFixture();
          mutate(ctx);
          let evaluation;
          expect(() => { evaluation = strategy.evaluate(ctx); }).not.toThrow();
          const e = evaluation!;
          const actionable =
            e.triggerMet === true && e.confidence >= MIN_STRATEGY_CONFIDENCE_TO_TRADE;
          expect(
            actionable,
            `${strategy.id} returned an ACTIONABLE evaluation (confidence ${e.confidence}, triggerMet ${e.triggerMet}) on degenerate input: ${name}`,
          ).toBe(false);
        });
      }
    });
  }
});
