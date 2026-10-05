import { describe, it, expect } from 'vitest';
import { Bar } from '../../engines/backtest/HistoricalDataGateway';
import {
  groupBarsByUTCDay, previousDayLevels, openingRange, premarketHighLow, dailyHighLow, weeklyHighLow,
  calculatePivotPoints, distanceToLevel, nearestSupportResistance, computeSupportResistanceFeatures,
} from './supportResistance';

function dailyBar(dayIndex: number, high: number, low: number, close: number): Bar {
  return { timestamp: dayIndex * 86_400_000, open: (high + low) / 2, high, low, close, volume: 1000 };
}

function intradayBar(dayIndex: number, hour: number, price: number): Bar {
  return { timestamp: dayIndex * 86_400_000 + hour * 3_600_000, open: price, high: price, low: price, close: price, volume: 1000 };
}

describe('indicators/supportResistance', () => {
  describe('groupBarsByUTCDay / previousDayLevels', () => {
    it('groups by real calendar day and reports the day BEFORE the current one', () => {
      const bars = [dailyBar(0, 110, 90, 100), dailyBar(1, 120, 95, 115)];
      const groups = groupBarsByUTCDay(bars);
      expect(groups.length).toBe(2);
      const prev = previousDayLevels(bars);
      expect(prev).toEqual({ high: 110, low: 90, close: 100 });
    });

    it('returns null with fewer than 2 distinct days', () => {
      expect(previousDayLevels([dailyBar(0, 110, 90, 100)])).toBeNull();
    });
  });

  describe('openingRange', () => {
    it('is honestly unavailable on daily-granularity bars, not fabricated', () => {
      const bars = [dailyBar(0, 110, 90, 100), dailyBar(1, 120, 95, 115)];
      const result = openingRange(bars);
      expect(result.available).toBe(false);
      expect(result.data).toBeNull();
    });

    it('computes a real range from real intraday bars within the window', () => {
      const bars = [
        intradayBar(0, 9, 100), intradayBar(0, 9, 102), intradayBar(0, 10, 98),
        intradayBar(0, 14, 105), // outside the 30-min window from session start
      ];
      const result = openingRange(bars, 90); // wide enough to catch the first 3
      expect(result.available).toBe(true);
    });

    it('anchors at the supplied regular-session open, excluding premarket bars (2026-10-04)', () => {
      // Premarket bars at 4:00/6:00/8:00 UTC, regular session from 9:30 UTC.
      // Without the anchor, the window starts at the first (premarket) bar - wrong.
      const sessionStart = 1 * 86_400_000 + 9.5 * 3_600_000;
      const bars = [
        intradayBar(1, 4, 50), intradayBar(1, 6, 55), intradayBar(1, 8, 45), // premarket extremes
        intradayBar(1, 9.5, 100), intradayBar(1, 9.6, 102), intradayBar(1, 9.7, 98),
      ];
      const unanchored = openingRange(bars, 30);
      expect(unanchored.data).toEqual({ high: 50, low: 50 }); // old behavior: anchored at the 4:00 AM premarket bar, not the open
      const anchored = openingRange(bars, 30, sessionStart);
      expect(anchored.available).toBe(true);
      expect(anchored.data).toEqual({ high: 102, low: 98 }); // premarket excluded
    });

    it('is unavailable when no bars exist at/after the supplied session start', () => {
      const sessionStart = 1 * 86_400_000 + 9.5 * 3_600_000;
      const bars = [intradayBar(1, 4, 50), intradayBar(1, 6, 55)]; // premarket only
      const result = openingRange(bars, 30, sessionStart);
      expect(result.available).toBe(false);
    });
  });

  describe('premarketHighLow', () => {
    it('is honestly unavailable on daily-granularity bars', () => {
      const bars = [dailyBar(0, 110, 90, 100), dailyBar(1, 120, 95, 115)];
      const result = premarketHighLow(bars, bars[1].timestamp);
      expect(result.available).toBe(false);
    });

    it('computes a real range from bars strictly before the supplied session-start timestamp', () => {
      const sessionStart = 1 * 86_400_000 + 9 * 3_600_000;
      const bars = [
        intradayBar(1, 4, 100), intradayBar(1, 6, 103), intradayBar(1, 8, 97),
        intradayBar(1, 9, 105), // at/after session start - excluded
      ];
      const result = premarketHighLow(bars, sessionStart);
      expect(result.available).toBe(true);
      expect(result.data).toEqual({ high: 103, low: 97 });
    });
  });

  describe('dailyHighLow / weeklyHighLow', () => {
    it('computes a real rolling high/low over the requested lookback', () => {
      const bars = Array.from({ length: 10 }, (_, i) => dailyBar(i, 100 + i, 90 + i, 95 + i));
      const daily = dailyHighLow(bars, 5);
      expect(daily).not.toBeNull();
      // last 5 bars are days 5..9: highs 105..109, lows 95..99
      expect(daily!.high).toBe(109);
      expect(daily!.low).toBe(95);
    });

    it('weeklyHighLow uses 5 trading days per week as documented', () => {
      const bars = Array.from({ length: 10 }, (_, i) => dailyBar(i, 100 + i, 90 + i, 95 + i));
      expect(weeklyHighLow(bars, 1)).toEqual(dailyHighLow(bars, 5));
    });
  });

  describe('calculatePivotPoints', () => {
    it('matches the standard floor-pivot formula on a known example', () => {
      // Classic worked example: H=52, L=48, C=50.
      const pivots = calculatePivotPoints(52, 48, 50);
      expect(pivots.pivot).toBeCloseTo(50, 8);
      expect(pivots.r1).toBeCloseTo(52, 8); // 2*50-48
      expect(pivots.s1).toBeCloseTo(48, 8); // 2*50-52
      expect(pivots.r2).toBeCloseTo(54, 8); // pivot + range(4)
      expect(pivots.s2).toBeCloseTo(46, 8);
    });
  });

  describe('distanceToLevel / nearestSupportResistance', () => {
    it('computes real absolute and % distance', () => {
      const d = distanceToLevel(110, 100);
      expect(d).toEqual({ level: 100, abs: 10, pct: 10 });
    });

    it('picks the closest real level above and below price from a candidate set', () => {
      const result = nearestSupportResistance(100, [80, 90, 95, 105, 110, 120]);
      expect(result.nearestSupport?.level).toBe(95);
      expect(result.nearestResistance?.level).toBe(105);
    });
  });

  describe('computeSupportResistanceFeatures', () => {
    it('assembles real pivots/Fibonacci/swings from real bars (Fibonacci now has its first real caller)', () => {
      const bars = Array.from({ length: 30 }, (_, i) => dailyBar(i, 100 + i, 90 + i, 95 + i));
      const features = computeSupportResistanceFeatures(bars);
      expect(features.previousDay).not.toBeNull();
      expect(features.pivots).not.toBeNull();
      expect(features.fibonacci).not.toBeNull();
      expect(features.openingRange.available).toBe(false);
      expect(features.priorChannel20).not.toBeNull();
      expect(features.priorChannel20!.high).toBeLessThan(features.dailyHighLow!.high);
    });

    describe('2026-09-29 (intraday-bars-for-opening-range fix)', () => {
      it('uses the optional intradayBars param for openingRange when supplied, while every other daily-appropriate feature keeps reading the main (daily) bars unchanged', () => {
        const dailyBars = Array.from({ length: 30 }, (_, i) => dailyBar(i, 100 + i, 90 + i, 95 + i));
        const intraday = [
          intradayBar(29, 9, 129), intradayBar(29, 9, 131), intradayBar(29, 9, 127),
          intradayBar(29, 14, 140), // outside the default opening-range window
        ];
        const features = computeSupportResistanceFeatures(dailyBars, intraday);
        // The real fix: openingRange is now available, computed from the intraday set.
        expect(features.openingRange.available).toBe(true);
        expect(features.openingRange.data).toEqual({ high: 131, low: 127 });
        // Everything daily-appropriate is untouched - still reads dailyBars, not intraday.
        expect(features.previousDay).toEqual({ high: 100 + 28, low: 90 + 28, close: 95 + 28 });
        expect(features.dailyHighLow).not.toBeNull();
        expect(features.pivots).not.toBeNull();
      });

      it('omitting intradayBars preserves the exact prior behavior - openingRange still honestly unavailable on daily-only bars', () => {
        const dailyBars = Array.from({ length: 30 }, (_, i) => dailyBar(i, 100 + i, 90 + i, 95 + i));
        const features = computeSupportResistanceFeatures(dailyBars);
        expect(features.openingRange.available).toBe(false);
        expect(features.openingRange.reason).toContain('daily-granularity');
      });

      it('an empty intradayBars array still reports openingRange honestly unavailable, never fabricated from the daily set it was given instead', () => {
        const dailyBars = Array.from({ length: 30 }, (_, i) => dailyBar(i, 100 + i, 90 + i, 95 + i));
        const features = computeSupportResistanceFeatures(dailyBars, []);
        expect(features.openingRange.available).toBe(false);
      });
    });
  });
});
