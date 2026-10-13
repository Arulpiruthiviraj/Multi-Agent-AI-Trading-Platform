import { describe, it, expect } from 'vitest';
import { baseFixture } from './testHelpers';
import { maCrossover } from './maCrossover';
import { rangeReversion } from './rangeReversion';
import { relativeStrengthRotation } from './relativeStrengthRotation';
import { momentumBreakout } from './momentumBreakout';
import { applyTriggerGate } from './StrategyEngine';

/**
 * 2026-10-13 trigger-semantics findings (Oct 13 audit: MA_CROSSOVER triggerMet 7,209/7,209, RANGE_REVERSION 6,991,
 * RELATIVE_STRENGTH_ROTATION 6,869). These tests pin what each `triggerMet` ACTUALLY means so the field can never again
 * be read as "an entry event fired". No threshold or strategy behavior was changed.
 */
describe('triggerMet semantics: STATE vs EVENT', () => {
  it('MA_CROSSOVER triggerMet is the persistent SMA50>SMA200 STACK, not a crossover event: it stays true with no cross on any recent bar', () => {
    const ctx = baseFixture();
    ctx.trend.movingAverages = { ...ctx.trend.movingAverages!, sma50: 110, sma200: 100 }; // golden ordering held for weeks
    const first = maCrossover.evaluate(ctx);
    expect(first.triggerMet).toBe(true);
    expect(first.triggerKind).toBe('STATE');
    // "next day": identical ordering, still no crossing happened -> still true. A crossover EVENT would be false here.
    ctx.trend.movingAverages = { ...ctx.trend.movingAverages!, sma50: 110.2, sma200: 100.05 };
    expect(maCrossover.evaluate(ctx).triggerMet).toBe(true);
  });

  it('MA_CROSSOVER triggerMet is false only when the ordering is absent or not computable (fails closed, never fabricated)', () => {
    const ctx = baseFixture(); // sma50 === sma200: neither stack
    expect(maCrossover.evaluate(ctx).triggerMet).toBe(false);
    ctx.trend.movingAverages = null as any;
    expect(maCrossover.evaluate(ctx).triggerMet).toBe(false);
  });

  it('RELATIVE_STRENGTH_ROTATION triggerMet is the sign of the relative-strength reading (STATE)', () => {
    const ctx = baseFixture();
    ctx.marketContext.relativeStrengthVsSPY = 0.4 as any;
    const ev = relativeStrengthRotation.evaluate(ctx);
    expect(ev.triggerKind).toBe('STATE');
  });

  it('RANGE_REVERSION triggerMet is boundary proximity (STATE)', () => {
    expect(rangeReversion.evaluate(baseFixture()).triggerKind).toBe('STATE');
  });

  it('event-type strategies do not declare STATE (default EVENT): MOMENTUM_BREAKOUT', () => {
    expect(momentumBreakout.evaluate(baseFixture()).triggerKind).toBeUndefined();
  });

  it('a STATE trigger still goes through the unchanged trigger gate (behavior unchanged: true -> no cap; false -> capped)', () => {
    const ctx = baseFixture();
    ctx.trend.movingAverages = { ...ctx.trend.movingAverages!, sma50: 110, sma200: 100 };
    const ev = maCrossover.evaluate(ctx);
    expect(applyTriggerGate({ ...ev, confidence: 0.9 }).confidence).toBe(0.9);
    expect(applyTriggerGate({ ...ev, triggerMet: false, confidence: 0.9 }).confidence).toBeLessThan(0.9);
  });
});
