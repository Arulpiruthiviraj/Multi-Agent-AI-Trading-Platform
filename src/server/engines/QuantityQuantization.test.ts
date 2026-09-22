import { describe, it, expect } from 'vitest';
import { quantizeQuantityDown } from './QuantityQuantization';

describe('quantizeQuantityDown', () => {
  it('step=1: exact Math.floor, matching existing equity behavior', () => {
    expect(quantizeQuantityDown(12.91, 1)).toBe(12);
    expect(quantizeQuantityDown(12, 1)).toBe(12);
    expect(quantizeQuantityDown(3000 / 250, 1)).toBe(12);
    expect(quantizeQuantityDown(3000 / 251, 1)).toBe(11);
  });

  it('mandate example: step=0.001', () => {
    expect(quantizeQuantityDown(0.12389, 0.001)).toBe(0.123);
  });

  it('mandate example: step=0.000001', () => {
    expect(quantizeQuantityDown(0.01234591, 0.000001)).toBe(0.012345);
  });

  it('BTC-scale step=0.00000001 (satoshi)', () => {
    expect(quantizeQuantityDown(0.123456789, 0.00000001)).toBe(0.12345678);
  });

  it('never rounds up', () => {
    expect(quantizeQuantityDown(0.999999, 0.001)).toBe(0.999);
    expect(quantizeQuantityDown(1.9999999, 1)).toBe(1);
  });

  it('exact multiples of step are preserved, not decremented by one step', () => {
    expect(quantizeQuantityDown(0.05, 0.01)).toBe(0.05);
    expect(quantizeQuantityDown(1, 0.001)).toBe(1);
    expect(quantizeQuantityDown(2, 1)).toBe(2);
  });

  it('absorbs ordinary binary floating-point representation error without rounding up past a true boundary', () => {
    // 0.1 + 0.2 famously renders as 0.30000000000000004 in IEEE-754 doubles.
    const raw = 0.1 + 0.2;
    expect(quantizeQuantityDown(raw, 0.1)).toBe(0.3);
    // A quantity genuinely below a step boundary must still floor down, not round up.
    expect(quantizeQuantityDown(0.299999, 0.1)).toBe(0.2);
  });

  it('returns 0 for non-finite, zero, or negative raw quantity', () => {
    expect(quantizeQuantityDown(NaN, 1)).toBe(0);
    expect(quantizeQuantityDown(Infinity, 1)).toBe(0);
    expect(quantizeQuantityDown(0, 1)).toBe(0);
    expect(quantizeQuantityDown(-5, 1)).toBe(0);
  });

  it('returns 0 for non-finite, zero, or negative step', () => {
    expect(quantizeQuantityDown(10, 0)).toBe(0);
    expect(quantizeQuantityDown(10, -1)).toBe(0);
    expect(quantizeQuantityDown(10, NaN)).toBe(0);
  });

  it('quantity below one step floors to zero (min-quantity/min-notional enforcement lives in PositionSizing.ts, not here)', () => {
    expect(quantizeQuantityDown(0.5, 1)).toBe(0);
    expect(quantizeQuantityDown(0.0000001, 0.00000001)).toBeCloseTo(0.0000001, 10);
  });

  it('critical invariant: quantized*step-implied value never exceeds the raw input (never rounds up)', () => {
    const cases: Array<[number, number]> = [
      [12.91, 1], [0.12389, 0.001], [0.01234591, 0.000001], [0.123456789, 0.00000001],
      [1199.999995, 1], [3000 / 60000, 0.00000001],
    ];
    for (const [raw, step] of cases) {
      const result = quantizeQuantityDown(raw, step);
      expect(result).toBeLessThanOrEqual(raw + 1e-9);
    }
  });
});
