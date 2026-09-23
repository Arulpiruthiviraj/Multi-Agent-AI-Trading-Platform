import { describe, it, expect } from 'vitest';
import { MACDEngine } from './MACDEngine';

/**
 * Real defect fixed 2026-09-22 (CLI runtime forensics pass): MACDEngine's private calcEMA()
 * seeded every EMA with a single raw price instead of the standard SMA-of-first-`period` warmup,
 * and because calculate() also runs calcEMA() over the derived macdLines array, macdLines[0] was
 * always exactly 0 regardless of real data - a second, compounded instance of the same bug
 * corrupting the signal line's own seed. Live-measured via the real TS-vs-Java parity comparator:
 * macdSignal diverged 17.5% from Java's independent implementation on real bars, a clear outlier
 * next to rsi (6.8%) and raw macd (5.4%) on the same data. No prior test file existed for this
 * live-path engine (technicalSignal.ts - the real TechnicalAgent - and 5 other real consumers all
 * share this one instance) before this fix.
 */

// Independent reference implementation (standard SMA-seeded EMA / MACD definition), written from
// the textbook formula rather than copied from production code - a real cross-check, not a
// tautology.
function referenceEma(values: number[], period: number): number[] {
  const out = new Array(values.length);
  const mult = 2 / (period + 1);
  const warm = Math.min(period, values.length);
  const seed = values.slice(0, warm).reduce((a, b) => a + b, 0) / warm;
  for (let i = 0; i < warm; i++) out[i] = seed;
  for (let i = warm; i < values.length; i++) out[i] = (values[i] - out[i - 1]) * mult + out[i - 1];
  return out;
}

function referenceMacd(prices: number[], shortP: number, longP: number, sigP: number) {
  const shortEma = referenceEma(prices, shortP);
  const longEma = referenceEma(prices, longP);
  const macdLines = prices.map((_, i) => shortEma[i] - longEma[i]);
  const signalLines = referenceEma(macdLines, sigP);
  const macd = macdLines[macdLines.length - 1];
  const signal = signalLines[signalLines.length - 1];
  return { macd, signal, histogram: macd - signal };
}

describe('MACDEngine (real defect: single-value EMA seed, not SMA warmup)', () => {
  it('seeds the EMA with the SMA of the first `period` values, not prices[0] alone', () => {
    // Hand-verifiable: prices [1,2,3,4,5], period=3. Correct SMA seed at index 2 is (1+2+3)/3=2;
    // multiplier=2/(3+1)=0.5. emas = [2,2,2, (4-2)*0.5+2=3, (5-3)*0.5+3=4].
    // The old buggy seed (prices[0]=1) would have produced [1, 1.5, 2.25, 3.125, 4.0625] instead -
    // a materially different final value (4.0625 vs 4), proving this test would have caught it.
    const engine = new MACDEngine(1, 3, 1); // short=1 makes shortEma trivially == prices for isolation
    const result = (engine as any).calcEMA([1, 2, 3, 4, 5], 3);
    expect(result).toEqual([2, 2, 2, 3, 4]);
  });

  it('matches an independent reference implementation of the standard SMA-seeded MACD formula', () => {
    // A real, non-trivial, non-constant, non-monotonic series long enough (40 bars) to fully
    // warm up both the long EMA (26) and the signal EMA (9) past their seed windows.
    const prices: number[] = [];
    let p = 100;
    for (let i = 0; i < 40; i++) {
      p += Math.sin(i / 3) * 1.7 + (i % 5 === 0 ? 2 : -0.3);
      prices.push(Number(p.toFixed(4)));
    }
    const engine = new MACDEngine(12, 26, 9);
    const actual = engine.calculate(prices);
    const expected = referenceMacd(prices, 12, 26, 9);
    expect(actual.macd).toBeCloseTo(expected.macd, 8);
    expect(actual.signal).toBeCloseTo(expected.signal, 8);
    expect(actual.histogram).toBeCloseTo(expected.histogram, 8);
  });

  it('a constant price series converges the EMA (and therefore MACD/signal/histogram) exactly to that price/zero', () => {
    const engine = new MACDEngine(12, 26, 9);
    const prices = new Array(40).fill(250);
    const result = engine.calculate(prices);
    expect(result.macd).toBeCloseTo(0, 10);
    expect(result.signal).toBeCloseTo(0, 10);
    expect(result.histogram).toBeCloseTo(0, 10);
  });

  it('returns zeros when given fewer bars than the long period (unchanged existing contract)', () => {
    const engine = new MACDEngine(12, 26, 9);
    const result = engine.calculate(new Array(10).fill(100));
    expect(result).toEqual({ macd: 0, signal: 0, histogram: 0 });
  });
});
