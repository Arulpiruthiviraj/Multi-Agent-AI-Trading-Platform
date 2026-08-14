import { describe, it, expect } from 'vitest';
import { Bar } from '../../engines/backtest/HistoricalDataGateway';
import {
  volumeSMA, relativeVolume, isVolumeSpike, volumeROC, sessionStartOfDay, calculateSessionVWAP,
  computeVWAPContext, calculateCMF, calculateAD, computeVolumeFeatures,
} from './volume';

function bar(dayIndex: number, hourOfDay: number, price: number, volume: number): Bar {
  const timestamp = dayIndex * 86_400_000 + hourOfDay * 3_600_000;
  return { timestamp, open: price, high: price, low: price, close: price, volume };
}

describe('indicators/volume', () => {
  describe('volumeSMA / relativeVolume / isVolumeSpike', () => {
    it('computes a real average and flags a real spike', () => {
      const volumes = [...Array(20).fill(1000), 5000];
      expect(volumeSMA(volumes.slice(0, -1), 20)).toBe(1000);
      expect(relativeVolume(volumes)).toBe(5);
      expect(isVolumeSpike(volumes)).toBe(true);
      expect(isVolumeSpike(volumes, 20, 10)).toBe(false); // 5x doesn't clear a 10x bar
    });

    it('returns null with insufficient history', () => {
      expect(volumeSMA([1, 2], 20)).toBeNull();
      expect(relativeVolume([1, 2], 20)).toBeNull();
    });
  });

  describe('volumeROC', () => {
    it('matches a hand-computed % change', () => {
      const volumes = [...Array(10).fill(1000), 1200];
      expect(volumeROC(volumes, 10)).toBeCloseTo(20, 8);
    });
  });

  describe('calculateSessionVWAP', () => {
    it('resets at the session boundary rather than accumulating across all history', () => {
      // Day 0: constant price 100. Day 1: constant price 200. Session VWAP for day 1 should be
      // ~200, not a cumulative blend with day 0's 100 - proving the session reset actually works.
      const day0 = Array.from({ length: 5 }, (_, i) => bar(0, i, 100, 1000));
      const day1 = Array.from({ length: 5 }, (_, i) => bar(1, i, 200, 1000));
      const bars = [...day0, ...day1];
      const vwap = calculateSessionVWAP(bars, sessionStartOfDay(day1[0].timestamp));
      expect(vwap).toBeCloseTo(200, 5);
    });

    it('returns null for an empty bar array', () => {
      expect(calculateSessionVWAP([])).toBeNull();
    });
  });

  describe('computeVWAPContext', () => {
    it('detects a real reclaim: prior close below session VWAP, current close above it', () => {
      // Session starts low (95), stays near 95 for a while (VWAP settles near 95), then a real
      // bar closes decisively above that settled VWAP.
      const bars: Bar[] = [];
      for (let i = 0; i < 5; i++) bars.push(bar(0, i, 95, 1000));
      bars.push(bar(0, 5, 94, 1000)); // still below VWAP
      bars.push(bar(0, 6, 110, 1000)); // decisive close above VWAP
      const ctx = computeVWAPContext(bars);
      expect(ctx.vwap).not.toBeNull();
      expect(ctx.event).toBe('RECLAIM');
    });

    it('reports NONE with no prior bar to compare against', () => {
      const bars = [bar(0, 0, 100, 1000)];
      expect(computeVWAPContext(bars).event).toBe('NONE');
    });
  });

  describe('calculateCMF / calculateAD', () => {
    it('is strongly positive when every bar closes near its high (real accumulation)', () => {
      const bars: Bar[] = Array.from({ length: 25 }, (_, i) => ({
        timestamp: i * 86_400_000, open: 98, high: 102, low: 98, close: 101.5, volume: 1000,
      }));
      const cmf = calculateCMF(bars);
      expect(cmf).not.toBeNull();
      expect(cmf as number).toBeGreaterThan(0.5);
      expect(calculateAD(bars)).toBeGreaterThan(0);
    });

    it('is strongly negative when every bar closes near its low (real distribution)', () => {
      const bars: Bar[] = Array.from({ length: 25 }, (_, i) => ({
        timestamp: i * 86_400_000, open: 102, high: 102, low: 98, close: 98.5, volume: 1000,
      }));
      const cmf = calculateCMF(bars);
      expect(cmf).not.toBeNull();
      expect(cmf as number).toBeLessThan(-0.5);
    });

    it('skips zero-range bars rather than dividing by zero', () => {
      const bars: Bar[] = Array.from({ length: 25 }, (_, i) => ({
        timestamp: i * 86_400_000, open: 100, high: 100, low: 100, close: 100, volume: 1000,
      }));
      expect(calculateCMF(bars)).toBeNull();
      expect(calculateAD(bars)).toBe(0);
    });
  });

  describe('computeVolumeFeatures', () => {
    it('assembles real OBV/MFI (via existing TechnicalIndicators) with the new features', () => {
      const bars: Bar[] = Array.from({ length: 30 }, (_, i) => ({
        timestamp: i * 86_400_000, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1000 + i * 10,
      }));
      const features = computeVolumeFeatures(bars);
      expect(typeof features.obv).toBe('number');
      expect(typeof features.mfi).toBe('number');
      expect(features.relativeVolume).not.toBeNull();
    });
  });
});
