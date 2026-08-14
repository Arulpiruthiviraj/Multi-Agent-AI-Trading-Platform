import { describe, it, expect } from 'vitest';
import { Bar } from '../../engines/backtest/HistoricalDataGateway';
import {
  detectBreakout, detectFalseBreakout, detectPullback, rangeExpansionContraction, detectConsolidation,
  detectGap, detectCandlestickPattern, computePriceActionFeatures,
} from './priceAction';

function bar(i: number, open: number, high: number, low: number, close: number): Bar {
  return { timestamp: i * 86_400_000, open, high, low, close, volume: 1000 };
}

describe('indicators/priceAction', () => {
  describe('detectBreakout', () => {
    it('requires confirmBars consecutive closes beyond the level, not a single wick', () => {
      const bars = [bar(0, 100, 105, 99, 104), bar(1, 104, 106, 103, 105)];
      expect(detectBreakout(bars, 100, 'UP', 2).breakout).toBe(true);
      expect(detectBreakout(bars, 106, 'UP', 2).breakout).toBe(false);
    });
  });

  describe('detectFalseBreakout', () => {
    it('flags a real break-then-fail-back sequence', () => {
      const bars = [bar(0, 100, 108, 99, 106), bar(1, 106, 107, 97, 98)]; // broke above 105, then closed back under
      expect(detectFalseBreakout(bars, 105, 'UP')).toBe(true);
    });

    it('is false when price never actually broke out', () => {
      const bars = [bar(0, 100, 102, 99, 101), bar(1, 101, 102, 99, 100)];
      expect(detectFalseBreakout(bars, 105, 'UP')).toBe(false);
    });
  });

  describe('detectPullback', () => {
    it('is true when price sits within tolerance of the MA, respecting trend direction', () => {
      expect(detectPullback([bar(0, 100, 101, 99, 100.5)], 'UP', 100, 1.5)).toBe(true);
    });

    it('is false when price is far from the MA', () => {
      expect(detectPullback([bar(0, 100, 101, 99, 110)], 'UP', 100, 1.5)).toBe(false);
    });

    it('is false when the MA value is null', () => {
      expect(detectPullback([bar(0, 100, 101, 99, 100)], 'UP', null)).toBe(false);
    });
  });

  describe('rangeExpansionContraction', () => {
    it('detects real expansion when recent bar ranges are much wider than prior ones', () => {
      const priorBars = Array.from({ length: 15 }, (_, i) => bar(i, 100, 101, 99, 100));
      const recentBars = Array.from({ length: 5 }, (_, i) => bar(15 + i, 100, 110, 90, 100));
      expect(rangeExpansionContraction([...priorBars, ...recentBars])).toBe('EXPANDING');
    });

    it('detects real contraction the other direction', () => {
      const priorBars = Array.from({ length: 15 }, (_, i) => bar(i, 100, 110, 90, 100));
      const recentBars = Array.from({ length: 5 }, (_, i) => bar(15 + i, 100, 100.5, 99.5, 100));
      expect(rangeExpansionContraction([...priorBars, ...recentBars])).toBe('CONTRACTING');
    });
  });

  describe('detectConsolidation', () => {
    it('is true for a genuinely tight range', () => {
      const bars = Array.from({ length: 10 }, (_, i) => bar(i, 100, 100.5, 99.5, 100));
      expect(detectConsolidation(bars)).toBe(true);
    });

    it('is false for a wide range', () => {
      const bars = Array.from({ length: 10 }, (_, i) => bar(i, 100, 120, 80, 100));
      expect(detectConsolidation(bars)).toBe(false);
    });
  });

  describe('detectGap', () => {
    it('detects a real gap up between two distinct calendar days', () => {
      const day0 = [bar(0, 100, 102, 99, 100)];
      const day1 = [bar(1, 110, 112, 109, 111)]; // opens well above prior close
      const result = detectGap([...day0, ...day1]);
      expect(result.type).toBe('GAP_UP');
      expect(result.sizePct as number).toBeCloseTo(10, 5);
    });

    it('does not flag a small, normal open as a gap', () => {
      const day0 = [bar(0, 100, 102, 99, 100)];
      const day1 = [bar(1, 100.1, 102, 99, 101)];
      expect(detectGap([...day0, ...day1]).type).toBeNull();
    });
  });

  describe('detectCandlestickPattern', () => {
    it('detects a real doji (open ~= close)', () => {
      const bars = [bar(0, 100, 105, 95, 100.1)];
      expect(detectCandlestickPattern(bars)).toBe('DOJI');
    });

    it('detects a real hammer (long lower wick, small body near the top)', () => {
      // body=|99-98|=1 (must clear the doji threshold of body/range&lt;0.1 first), lowerWick=8
      // (&gt;2x body), upperWick=0.2 (&lt;0.5x body) - real hammer proportions, not a doji.
      const bars = [bar(0, 98, 99.2, 90, 99)];
      expect(detectCandlestickPattern(bars)).toBe('HAMMER');
    });

    it('detects a real bullish engulfing pattern across two bars', () => {
      const bars = [bar(0, 105, 106, 99, 100), bar(1, 99, 108, 98, 107)];
      expect(detectCandlestickPattern(bars)).toBe('BULLISH_ENGULFING');
    });

    it('returns null for a bar with no matching pattern', () => {
      const bars = [bar(0, 100, 103, 99, 102)];
      expect(detectCandlestickPattern(bars)).toBeNull();
    });
  });

  describe('computePriceActionFeatures', () => {
    it('assembles all real price-action features from a real bar array', () => {
      const bars = Array.from({ length: 20 }, (_, i) => bar(i, 100 + i, 101 + i, 99 + i, 100 + i));
      const features = computePriceActionFeatures(bars);
      expect(features.gap).toBeDefined();
      expect(typeof features.consolidating).toBe('boolean');
    });
  });
});
