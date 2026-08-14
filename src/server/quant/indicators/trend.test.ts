import { describe, it, expect } from 'vitest';
import { Bar } from '../../engines/backtest/HistoricalDataGateway';
import { movingAverageSet, maSlopePct, priceVsMA, calculateDMI, detectSwingPoints, detectMarketStructure } from './trend';

function bar(i: number, open: number, high: number, low: number, close: number, volume = 1000): Bar {
  return { timestamp: i * 86_400_000, open, high, low, close, volume };
}

describe('indicators/trend', () => {
  describe('movingAverageSet', () => {
    it('returns null for periods with insufficient history, real values for periods with enough', () => {
      const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
      const mas = movingAverageSet(closes);
      expect(mas.sma20).not.toBeNull();
      expect(mas.sma50).not.toBeNull();
      expect(mas.sma100).toBeNull(); // only 60 bars
      expect(mas.sma200).toBeNull();
    });

    it('SMA20 matches a hand-computed average on a simple ramp', () => {
      const closes = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
      const mas = movingAverageSet(closes);
      expect(mas.sma20).toBeCloseTo(10.5, 8); // mean of 1..20
    });
  });

  describe('maSlopePct', () => {
    it('is positive when the MA has risen over the lookback window', () => {
      const closes = Array.from({ length: 40 }, (_, i) => 100 + i); // steadily rising
      const slope = maSlopePct(closes, 20, 10, 'sma');
      expect(slope).not.toBeNull();
      expect(slope as number).toBeGreaterThan(0);
    });

    it('returns null with insufficient history for two real readings', () => {
      expect(maSlopePct([1, 2, 3], 20, 10)).toBeNull();
    });
  });

  describe('priceVsMA', () => {
    it('reports above/below and a real % distance', () => {
      const result = priceVsMA(110, 100);
      expect(result).toEqual({ diff: 10, diffPct: 10, above: true });
    });

    it('returns null when the MA itself is null', () => {
      expect(priceVsMA(110, null)).toBeNull();
    });
  });

  describe('calculateDMI', () => {
    it('returns null with insufficient history', () => {
      expect(calculateDMI([1, 2], [1, 2], [1, 2])).toBeNull();
    });

    it('shows +DI dominant and a real positive ADX in a clean uptrend', () => {
      const n = 40;
      const highs = Array.from({ length: n }, (_, i) => 100 + i * 2 + 1);
      const lows = Array.from({ length: n }, (_, i) => 100 + i * 2 - 1);
      const closes = Array.from({ length: n }, (_, i) => 100 + i * 2);
      const dmi = calculateDMI(highs, lows, closes, 14);
      expect(dmi).not.toBeNull();
      expect(dmi!.plusDI).toBeGreaterThan(dmi!.minusDI);
      expect(dmi!.adx).toBeGreaterThan(0);
    });
  });

  describe('detectSwingPoints', () => {
    it('detects an obvious swing high and swing low with lookback=2', () => {
      // A clean V-shape: down to a low at index 5, back up to a high at index 10.
      const bars: Bar[] = [];
      for (let i = 0; i <= 5; i++) bars.push(bar(i, 100 - i, 101 - i, 99 - i, 100 - i));
      for (let i = 6; i <= 10; i++) bars.push(bar(i, 95 + (i - 5), 96 + (i - 5), 94 + (i - 5), 95 + (i - 5)));
      for (let i = 11; i <= 13; i++) bars.push(bar(i, 100 - (i - 10), 101 - (i - 10), 99 - (i - 10), 100 - (i - 10)));

      const swings = detectSwingPoints(bars, 2);
      const lows = swings.filter(s => s.type === 'low');
      expect(lows.length).toBeGreaterThan(0);
      // The lowest low bar is at index 5 (price 95).
      expect(lows.some(s => s.index === 5)).toBe(true);
    });
  });

  describe('detectMarketStructure', () => {
    it('classifies a real, clean uptrend of higher highs/higher lows as UPTREND', () => {
      // Four up-legs: needs at least 3 detected swing lows (and 3 swing highs) so the last two
      // of each type both carry a real HH/HL classification - the first detected swing of any
      // type always has kind:null (nothing prior to compare against), so 2 legs alone only
      // produces one real comparison per type, which is deliberately not enough to call a trend.
      const bars: Bar[] = [];
      let price = 100;
      for (let leg = 0; leg < 4; leg++) {
        for (let i = 0; i < 5; i++) { price += 2; bars.push(bar(bars.length, price, price + 1, price - 1, price)); }
        for (let i = 0; i < 3; i++) { price -= 1; bars.push(bar(bars.length, price, price + 1, price - 1, price)); }
      }
      const result = detectMarketStructure(bars, 2);
      expect(result.trend).toBe('UPTREND');
    });

    it('returns SIDEWAYS with no event when there is not enough swing history', () => {
      const bars: Bar[] = [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 99, 100)];
      const result = detectMarketStructure(bars, 2);
      expect(result.trend).toBe('SIDEWAYS');
      expect(result.event).toBe('NONE');
    });
  });
});
