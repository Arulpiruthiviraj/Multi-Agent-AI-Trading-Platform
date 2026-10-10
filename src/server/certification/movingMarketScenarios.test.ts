// LABEL: COMPONENT
/**
 * Moving-market scenario certification.
 *
 * Runs the REAL strategy engine (evaluateAll + bestStrategyIdea) against shaped market
 * scenarios and asserts expected strategy BEHAVIOR — never trades, never fills. Each
 * scenario mutates the shared baseFixture() into a recognizable market shape; the
 * assertions pin the behavior contract: which triggers fire, which contradictions
 * surface, and when the engine must stay quiet.
 *
 * These are BEHAVIORAL tests, not outcome tests: a failed breakout must produce a
 * contradiction or a withheld trigger, not a specific P&L. The engine's job is honest
 * signal classification; trade outcomes belong to backtests, not to this suite.
 */
import { describe, it, expect } from 'vitest';
import { evaluateAll, bestStrategyIdea } from '../quant/strategies/StrategyEngine';
import { baseFixture } from '../quant/strategies/testHelpers';
import type { StrategyContext } from '../quant/strategies/types';

/** Clean bullish momentum breakout: BOS + RVOL + ATR expansion + VWAP + regime + sector + RS + ROC. */
function momentumBreakoutCtx(): StrategyContext {
  const ctx = baseFixture();
  ctx.symbol = 'MOMO';
  ctx.currentPrice = 105;
  ctx.trend.structure = { trend: 'UPTREND', event: 'BOS_BULLISH', lastSwingHigh: 103, lastSwingLow: 98 };
  ctx.trend.movingAverages = { sma20: 100, sma50: 98, sma100: 95, sma200: 90, ema9: 103, ema20: 101, ema50: 99, ema200: 92 };
  ctx.volume.relativeVolume = 2.5;
  ctx.volume.isSpike = true;
  ctx.volume.vwap = { vwap: 103, distancePct: 1.9, slopePct: 0.5, event: 'NONE', intradayBased: true };
  ctx.volatility.regime = 'EXPANDING';
  ctx.volatility.atr = 2;
  ctx.regime = { ...ctx.regime, regime: 'BULLISH_TREND', trendStrength: 80, confidence: 0.85, marketStructure: 'TRENDING' };
  ctx.marketContext.sector = { name: 'Technology', etf: 'XLK', trend: { symbol: 'XLK', regime: 'BULLISH_TREND', source: 'test' } as any };
  ctx.marketContext.relativeStrengthVsSPY = { relativeStrengthPct: 2.5 } as any;
  ctx.momentum.roc = 3.2;
  ctx.momentum.rsi = 65;
  ctx.supportResistance.nearest = { nearestResistance: { level: 108 } as any, nearestSupport: { level: 103 } as any };
  return ctx;
}

describe('moving-market scenarios (strategy behavior, not trades)', () => {
  it('clean momentum breakout: trigger fires, setup is strong, best idea is MOMENTUM_BREAKOUT', () => {
    const results = evaluateAll(momentumBreakoutCtx());
    const momo = results.find(r => r.strategy === 'MOMENTUM_BREAKOUT')!;
    expect(momo.triggerMet).toBe(true);
    expect(momo.side).toBe('BUY');
    // 8/8 conditions met => setupScore 100; assert the strong-setup bar, not the exact number.
    expect(momo.setupScore).toBeGreaterThanOrEqual(75);
    expect(momo.contradictions).toHaveLength(0);
    const idea = bestStrategyIdea(results);
    expect(idea).not.toBeNull();
    expect(idea!.strategy).toBe('MOMENTUM_BREAKOUT');
  });

  it('exhausted breakout (RSI 85 + shooting star): trigger still fires but contradictions are loud', () => {
    const ctx = momentumBreakoutCtx();
    ctx.momentum.rsi = 85;
    ctx.priceAction.candlestick = 'SHOOTING_STAR' as any;
    const results = evaluateAll(ctx);
    const momo = results.find(r => r.strategy === 'MOMENTUM_BREAKOUT')!;
    // The structural break really happened — triggerMet stays honest (true), but the
    // engine must surface BOTH exhaustion contradictions rather than a clean setup.
    expect(momo.triggerMet).toBe(true);
    expect(momo.contradictions.length).toBeGreaterThanOrEqual(2);
    expect(momo.contradictions.join(' ')).toMatch(/overbought/i);
    expect(momo.contradictions.join(' ')).toMatch(/SHOOTING_STAR/);
  });

  it('failed breakout (no BOS, price back under resistance): trigger withheld, setup collapses', () => {
    const ctx = momentumBreakoutCtx();
    ctx.trend.structure = { trend: 'UPTREND', event: 'NONE', lastSwingHigh: 106, lastSwingLow: 98 };
    ctx.currentPrice = 104; // back below the 106 level that never broke
    ctx.volume.relativeVolume = 0.8; // no RVOL confirmation
    ctx.momentum.roc = -0.5;
    const results = evaluateAll(ctx);
    const momo = results.find(r => r.strategy === 'MOMENTUM_BREAKOUT')!;
    expect(momo.triggerMet).toBe(false);
    // Half the bullish backdrop (regime, sector, VWAP, ATR) is still honestly true — the
    // setupScore reflects that (50), but without the trigger the idea must never surface.
    expect(momo.setupScore).toBeLessThan(75);
    // bestStrategyIdea must not surface a breakout idea from a non-breakout.
    const idea = bestStrategyIdea(results);
    if (idea) {
      expect(idea.strategy).not.toBe('MOMENTUM_BREAKOUT');
    }
  });

  it('sideways chop (neutral fixture): no trigger fires with a tradeable setup; engine stays quiet', () => {
    const ctx = baseFixture(); // RSI 50, no volume, SIDEWAYS regime, no structural event
    const results = evaluateAll(ctx);
    const triggered = results.filter(r => r.triggerMet && r.setupScore >= 75);
    expect(triggered).toHaveLength(0);
    const idea = bestStrategyIdea(results);
    // Either null or a below-bar idea the downstream confidence gate will reject.
    if (idea) {
      expect(idea.confidence).toBeLessThan(0.75);
    }
  });
});
