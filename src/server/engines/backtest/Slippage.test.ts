import { describe, it, expect } from 'vitest';
import { calculateDynamicSlippagePct, BASE_SLIPPAGE_PCT } from './Slippage';

function flatBars(n: number, price: number, volume: number) {
  return {
    highs: Array.from({ length: n }, () => price),
    lows: Array.from({ length: n }, () => price),
    closes: Array.from({ length: n }, () => price),
    currentPrice: price,
    barVolume: volume,
  };
}

describe('calculateDynamicSlippagePct', () => {
  it('never goes below the base floor even for a perfectly flat, zero-volatility series', () => {
    const slip = calculateDynamicSlippagePct({ ...flatBars(30, 100, 1_000_000), orderShares: 1 });
    expect(slip).toBeCloseTo(BASE_SLIPPAGE_PCT, 5);
  });

  it('increases with real measured volatility (ATR) relative to price', () => {
    const highs = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 5 : 0));
    const lows = Array.from({ length: 30 }, (_, i) => 100 - (i % 2 === 0 ? 5 : 0));
    const closes = Array.from({ length: 30 }, () => 100);
    const volatile = calculateDynamicSlippagePct({ highs, lows, closes, currentPrice: 100, orderShares: 1, barVolume: 1_000_000 });
    const flat = calculateDynamicSlippagePct({ ...flatBars(30, 100, 1_000_000), orderShares: 1 });
    expect(volatile).toBeGreaterThan(flat);
  });

  it('increases with order size relative to the bar\'s real traded volume', () => {
    const small = calculateDynamicSlippagePct({ ...flatBars(30, 100, 100_000), orderShares: 100 });
    const large = calculateDynamicSlippagePct({ ...flatBars(30, 100, 100_000), orderShares: 50_000 });
    expect(large).toBeGreaterThan(small);
  });

  it('never fabricates infinite slippage on a zero-volume bar - caps out sensibly instead', () => {
    const slip = calculateDynamicSlippagePct({ ...flatBars(30, 100, 0), orderShares: 1000 });
    expect(Number.isFinite(slip)).toBe(true);
    expect(slip).toBeLessThanOrEqual(0.05);
  });

  it('is bounded by a real sanity ceiling regardless of how extreme the inputs are', () => {
    const highs = Array.from({ length: 30 }, () => 1000);
    const lows = Array.from({ length: 30 }, () => 1);
    const closes = Array.from({ length: 30 }, () => 500);
    const slip = calculateDynamicSlippagePct({ highs, lows, closes, currentPrice: 500, orderShares: 1_000_000, barVolume: 1 });
    expect(slip).toBeLessThanOrEqual(0.05);
  });
});
