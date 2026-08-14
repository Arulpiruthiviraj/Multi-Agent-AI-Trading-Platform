import { describe, it, expect } from 'vitest';
import { rangeReversion } from './rangeReversion';
import { baseFixture } from './testHelpers';

describe('rangeReversion', () => {
  it('scores a full fade-off-support setup highly and picks BUY when price sits nearer support', () => {
    const ctx = baseFixture();
    ctx.regime.marketStructure = 'RANGING';
    ctx.priceAction.consolidating = true;
    ctx.supportResistance.nearest = {
      nearestSupport: { level: 99, abs: 1, pct: 1.01 }, // close (<=1.5%)
      nearestResistance: { level: 110, abs: -9, pct: -8.18 }, // far
    };
    ctx.momentum.rsi = 35;
    ctx.volume.isSpike = false;
    ctx.trend.structure.event = 'NONE';

    const result = rangeReversion.evaluate(ctx);

    expect(result.side).toBe('BUY');
    expect(result.setupScore).toBe(100);
    expect(result.target.price).toBe(110);
  });

  it('mirrors correctly for a fade-off-resistance setup -> SELL when price sits nearer resistance', () => {
    const ctx = baseFixture();
    ctx.regime.marketStructure = 'RANGING';
    ctx.priceAction.consolidating = true;
    ctx.supportResistance.nearest = {
      nearestResistance: { level: 101, abs: -1, pct: -0.99 }, // close
      nearestSupport: { level: 90, abs: 10, pct: 11.1 }, // far
    };
    ctx.momentum.rsi = 65;
    ctx.volume.isSpike = false;

    const result = rangeReversion.evaluate(ctx);

    expect(result.side).toBe('SELL');
    expect(result.conditionsMet).toContain('Price near the range resistance boundary');
  });

  it('flags a real contradiction and a failed condition when a volume spike is present', () => {
    const ctx = baseFixture();
    ctx.regime.marketStructure = 'RANGING';
    ctx.priceAction.consolidating = true;
    ctx.supportResistance.nearest = { nearestSupport: { level: 99, abs: 1, pct: 1.01 }, nearestResistance: null };
    ctx.volume.isSpike = true;

    const result = rangeReversion.evaluate(ctx);

    expect(result.conditionsFailed).toContain('No real volume spike (a genuine breakout would show one)');
    expect(result.contradictions).toContain('A real volume spike is present, which is itself evidence of a genuine breakout attempt rather than range-holding.');
  });

  it('flags a real contradiction when no nearest support/resistance level exists at all', () => {
    const ctx = baseFixture();
    ctx.supportResistance.nearest = { nearestSupport: null, nearestResistance: null };

    const result = rangeReversion.evaluate(ctx);

    expect(result.contradictions).toContain('No real nearest support/resistance level exists yet - this strategy cannot honestly identify a boundary to fade.');
  });

  it('derives stop just beyond the near boundary and target at the opposite (far) boundary', () => {
    const ctx = baseFixture();
    ctx.regime.marketStructure = 'RANGING';
    ctx.priceAction.consolidating = true;
    ctx.supportResistance.nearest = {
      nearestSupport: { level: 98, abs: 2, pct: 2.04 },
      nearestResistance: { level: 112, abs: -12, pct: -10.7 },
    };

    const result = rangeReversion.evaluate(ctx);

    // supportDist(2.04) < resistanceDist(10.7) -> bullish fade off support
    expect(result.side).toBe('BUY');
    expect(result.stop.price).toBe(98);
    expect(result.target.price).toBe(112);
  });
});
