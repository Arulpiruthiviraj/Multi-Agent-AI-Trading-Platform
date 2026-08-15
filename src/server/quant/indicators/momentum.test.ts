import { describe, it, expect } from 'vitest';
import { calculateROC, calculateMomentum, calculateWilliamsR, calculateCCI, calculateStochasticRSI, computeMomentumFeatures, detectPriceOscillatorDivergence } from './momentum';
import { Bar } from '../../engines/backtest/HistoricalDataGateway';

describe('indicators/momentum', () => {
  describe('calculateROC', () => {
    it('matches a hand-computed % change', () => {
      const closes = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 110];
      expect(calculateROC(closes, 11)).toBeCloseTo(10, 8);
    });

    it('returns null with insufficient history', () => {
      expect(calculateROC([1, 2], 12)).toBeNull();
    });
  });

  describe('calculateMomentum', () => {
    it('is the raw price difference, not a percentage', () => {
      const closes = Array.from({ length: 11 }, () => 100);
      closes.push(115);
      expect(calculateMomentum(closes, 10)).toBeCloseTo(15, 8);
    });
  });

  describe('calculateWilliamsR', () => {
    it('is 0 when the close equals the period high', () => {
      const highs = [10, 11, 12, 13, 14];
      const lows = [5, 6, 7, 8, 9];
      const closes = [8, 9, 10, 11, 14]; // last close === last high
      expect(calculateWilliamsR(highs, lows, closes, 5)).toBeCloseTo(0, 8);
    });

    it('is -100 when the close equals the period low', () => {
      const highs = [10, 11, 12, 13, 14];
      const lows = [5, 6, 7, 8, 9];
      const closes = [8, 9, 10, 11, 5]; // last close === last low
      expect(calculateWilliamsR(highs, lows, closes, 5)).toBeCloseTo(-100, 8);
    });

    it('returns null on a flat (zero-range) window', () => {
      const flat = [10, 10, 10, 10, 10];
      expect(calculateWilliamsR(flat, flat, flat, 5)).toBeNull();
    });
  });

  describe('calculateCCI', () => {
    it('is 0 when the current typical price equals the SMA of typical prices', () => {
      // close=high-1=low+1 => typical price (h+l+c)/3 === close for every bar. Typical prices
      // [8,12,8,12,10] average to 10, matching the last bar's own typical price of 10, while
      // still varying bar-to-bar (real nonzero mean deviation, so CCI is actually computable).
      const closes = [8, 12, 8, 12, 10];
      const highs = closes.map(c => c + 1);
      const lows = closes.map(c => c - 1);
      const cci = calculateCCI(highs, lows, closes, 5);
      expect(cci).not.toBeNull();
      expect(cci as number).toBeCloseTo(0, 8);
    });

    it('returns null with insufficient history', () => {
      expect(calculateCCI([1], [1], [1], 20)).toBeNull();
    });
  });

  describe('calculateStochasticRSI', () => {
    it('returns null with insufficient combined history', () => {
      expect(calculateStochasticRSI(Array.from({ length: 10 }, (_, i) => 100 + i))).toBeNull();
    });

    it('is a real, finite 0-100 value with enough real history', () => {
      const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5);
      const stochRsi = calculateStochasticRSI(closes);
      expect(stochRsi).not.toBeNull();
      expect(stochRsi as number).toBeGreaterThanOrEqual(0);
      expect(stochRsi as number).toBeLessThanOrEqual(100);
    });
  });

  describe('computeMomentumFeatures', () => {
    it('assembles real RSI/MACD (from the existing engines) alongside the new features', () => {
      const bars: Bar[] = Array.from({ length: 40 }, (_, i) => ({
        timestamp: i * 86_400_000, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1000,
      }));
      const features = computeMomentumFeatures(bars);
      expect(typeof features.rsi).toBe('number');
      expect(features.rsi).toBeGreaterThanOrEqual(0);
      expect(features.rsi).toBeLessThanOrEqual(100);
      expect(typeof features.macd.macd).toBe('number');
      expect(features.roc).not.toBeNull();
      expect(features.momentum).not.toBeNull();
    });
  });

  describe('detectPriceOscillatorDivergence', () => {
    it('flags bullish divergence as a feature, never as a trade signal', () => {
      const price = [10, 9, 10, 8, 10, 9.5, 10, 7.5, 10];
      const oscillator = [20, 15, 20, 18, 20, 19, 20, 22, 20];
      const result = detectPriceOscillatorDivergence(price, oscillator);
      expect(result.kind).toBe('BULLISH');
      expect(result.isTradeSignal).toBe(false);
    });

    it('flags bearish divergence as a feature, never as a trade signal', () => {
      const price = [10, 12, 11, 14, 13, 15, 14, 16, 15];
      const oscillator = [50, 40, 45, 30, 35, 28, 32, 20, 25];
      const result = detectPriceOscillatorDivergence(price, oscillator);
      expect(result.kind).toBe('BEARISH');
      expect(result.isTradeSignal).toBe(false);
    });

    it('returns INSUFFICIENT_DATA without fabricating a kind', () => {
      const result = detectPriceOscillatorDivergence([1, 2, 3], [1, 2, 3]);
      expect(result.kind).toBeNull();
      expect(result.detail).toBe('INSUFFICIENT_DATA');
      expect(result.isTradeSignal).toBe(false);
    });
  });
});
