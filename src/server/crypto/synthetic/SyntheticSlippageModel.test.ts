import { describe, it, expect } from 'vitest';
import { SyntheticRandom } from '../../replay/synthetic/SyntheticRandom';
import { generateOrderBookSnapshot } from './SyntheticOrderBook';
import { estimateSlippage, classifyLiquidityCondition } from './SyntheticSlippageModel';

describe('classifyLiquidityCondition', () => {
  it('maps volatility multiplier bands to the expected condition', () => {
    expect(classifyLiquidityCondition(0.4)).toBe('LIQUID');
    expect(classifyLiquidityCondition(1.0)).toBe('NORMAL');
    expect(classifyLiquidityCondition(2.0)).toBe('ILLIQUID');
    expect(classifyLiquidityCondition(4.0)).toBe('CRISIS');
  });
});

describe('estimateSlippage', () => {
  const book = generateOrderBookSnapshot(new SyntheticRandom(1), 100, 'MID_CAP', 1.0);

  it('a larger order incurs more total slippage than a smaller one against the same book', () => {
    const small = estimateSlippage(1_000, book, 'BUY', 'MID_CAP', 1.0);
    const large = estimateSlippage(100_000, book, 'BUY', 'MID_CAP', 1.0);
    expect(large.totalSlippage).toBeGreaterThan(small.totalSlippage);
  });

  it('a micro-cap asset incurs more slippage than a large-cap asset for the same order size and book', () => {
    const largeCap = estimateSlippage(10_000, book, 'BUY', 'LARGE_CAP', 1.0);
    const microCap = estimateSlippage(10_000, book, 'BUY', 'MICRO_CAP', 1.0);
    expect(microCap.totalSlippage).toBeGreaterThan(largeCap.totalSlippage);
  });

  it('a crisis liquidity condition incurs more slippage than a normal condition for the same order', () => {
    const normalBook = generateOrderBookSnapshot(new SyntheticRandom(2), 100, 'MID_CAP', 1.0);
    const crisisBook = generateOrderBookSnapshot(new SyntheticRandom(2), 100, 'MID_CAP', 4.0);
    const normal = estimateSlippage(10_000, normalBook, 'BUY', 'MID_CAP', 1.0);
    const crisis = estimateSlippage(10_000, crisisBook, 'BUY', 'MID_CAP', 4.0);
    expect(crisis.totalSlippage).toBeGreaterThan(normal.totalSlippage);
    expect(crisis.liquidityCondition).toBe('CRISIS');
  });

  it('slippage is always non-negative', () => {
    const estimate = estimateSlippage(50_000, book, 'SELL', 'MID_CAP', 1.0);
    expect(estimate.totalSlippage).toBeGreaterThanOrEqual(0);
    expect(estimate.halfSpreadCost).toBeGreaterThanOrEqual(0);
    expect(estimate.marketImpactCost).toBeGreaterThanOrEqual(0);
  });

  it('an order many multiples larger than available depth does not throw or produce NaN/Infinity', () => {
    const estimate = estimateSlippage(book.totalAskDepth * 1000, book, 'BUY', 'MICRO_CAP', 1.0);
    expect(Number.isFinite(estimate.totalSlippage)).toBe(true);
  });
});
