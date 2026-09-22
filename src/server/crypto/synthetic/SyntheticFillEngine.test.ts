import { describe, it, expect } from 'vitest';
import { SyntheticRandom } from '../../replay/synthetic/SyntheticRandom';
import { generateOrderBookSnapshot } from './SyntheticOrderBook';
import { simulateFill } from './SyntheticFillEngine';

describe('simulateFill', () => {
  it('is deterministic given the same seed and inputs', () => {
    const book = generateOrderBookSnapshot(new SyntheticRandom(1), 100, 'MID_CAP', 1.0);
    const a = simulateFill(new SyntheticRandom(10), 'BUY', 5, 100, book, 'MID_CAP', 1.0);
    const b = simulateFill(new SyntheticRandom(10), 'BUY', 5, 100, book, 'MID_CAP', 1.0);
    expect(a).toEqual(b);
  });

  it('never mutates or recomputes the arrival price', () => {
    const book = generateOrderBookSnapshot(new SyntheticRandom(1), 100, 'MID_CAP', 1.0);
    const fill = simulateFill(new SyntheticRandom(11), 'BUY', 5, 100, book, 'MID_CAP', 1.0);
    expect(fill.arrivalPrice).toBe(100);
  });

  it('a BUY fill price is at or above arrival price (pays the spread/impact, never receives a discount)', () => {
    const book = generateOrderBookSnapshot(new SyntheticRandom(1), 100, 'MID_CAP', 1.0);
    const fill = simulateFill(new SyntheticRandom(12), 'BUY', 5, 100, book, 'MID_CAP', 1.0);
    if (fill.outcome !== 'REJECTED') {
      expect(fill.actualFillPrice).toBeGreaterThanOrEqual(100);
      expect(fill.signedSlippage).toBeGreaterThanOrEqual(0);
    }
  });

  it('a SELL fill price is at or below arrival price', () => {
    const book = generateOrderBookSnapshot(new SyntheticRandom(1), 100, 'MID_CAP', 1.0);
    const fill = simulateFill(new SyntheticRandom(13), 'SELL', 5, 100, book, 'MID_CAP', 1.0);
    if (fill.outcome !== 'REJECTED') {
      expect(fill.actualFillPrice).toBeLessThanOrEqual(100);
      expect(fill.signedSlippage).toBeLessThanOrEqual(0);
    }
  });

  it('fillQuantity + remainingQuantity always equals the requested quantity', () => {
    const book = generateOrderBookSnapshot(new SyntheticRandom(1), 100, 'MID_CAP', 1.0);
    for (let seed = 0; seed < 30; seed++) {
      const fill = simulateFill(new SyntheticRandom(seed), 'BUY', 10, 100, book, 'MID_CAP', 1.0);
      expect(fill.fillQuantity + fill.remainingQuantity).toBeCloseTo(10, 9);
    }
  });

  it('a rejected fill leaves the full quantity remaining and zero filled', () => {
    // Sweep seeds under crisis conditions (higher reject probability) until a REJECTED outcome appears.
    const book = generateOrderBookSnapshot(new SyntheticRandom(1), 100, 'MID_CAP', 5.0);
    let found = false;
    for (let seed = 0; seed < 500 && !found; seed++) {
      const fill = simulateFill(new SyntheticRandom(seed), 'BUY', 10, 100, book, 'MID_CAP', 5.0);
      if (fill.outcome === 'REJECTED') {
        found = true;
        expect(fill.fillQuantity).toBe(0);
        expect(fill.remainingQuantity).toBe(10);
      }
    }
    expect(found).toBe(true);
  });

  it('crisis conditions produce partial fills more often than liquid conditions across many seeds', () => {
    const liquidBook = generateOrderBookSnapshot(new SyntheticRandom(1), 100, 'LARGE_CAP', 0.5);
    const crisisBook = generateOrderBookSnapshot(new SyntheticRandom(1), 100, 'MICRO_CAP', 5.0);
    let liquidPartials = 0;
    let crisisPartials = 0;
    const n = 300;
    for (let seed = 0; seed < n; seed++) {
      if (simulateFill(new SyntheticRandom(seed), 'BUY', 10, 100, liquidBook, 'LARGE_CAP', 0.5).outcome === 'PARTIAL_FILL') liquidPartials++;
      if (simulateFill(new SyntheticRandom(seed + 10_000), 'BUY', 10, 100, crisisBook, 'MICRO_CAP', 5.0).outcome === 'PARTIAL_FILL') crisisPartials++;
    }
    expect(crisisPartials).toBeGreaterThan(liquidPartials);
  });
});
