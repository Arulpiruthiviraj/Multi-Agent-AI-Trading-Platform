import { describe, it, expect } from 'vitest';
import { Bar } from '../../engines/backtest/HistoricalDataGateway';
import { atrPercent, historicalVolatility, volatilityPercentile, bollingerBandWidth, keltnerChannels, classifyVolatilityRegime, computeVolatilityFeatures } from './volatility';

function makeBars(closes: number[], rangePct = 0.01): Bar[] {
  return closes.map((c, i) => ({
    timestamp: i * 86_400_000,
    open: c, close: c,
    high: c * (1 + rangePct), low: c * (1 - rangePct),
    volume: 1_000_000,
  }));
}

describe('indicators/volatility', () => {
  describe('atrPercent', () => {
    it('is a real, positive % for a series with real range', () => {
      const bars = makeBars(Array.from({ length: 20 }, () => 100));
      const pct = atrPercent(bars.map(b => b.high), bars.map(b => b.low), bars.map(b => b.close));
      expect(pct).not.toBeNull();
      expect(pct as number).toBeGreaterThan(0);
    });

    it('returns null when there is no current price', () => {
      expect(atrPercent([], [], [])).toBeNull();
    });
  });

  describe('historicalVolatility', () => {
    it('is 0 for a perfectly steady compounding series', () => {
      const closes = [100];
      for (let i = 0; i < 25; i++) closes.push(closes[closes.length - 1] * 1.005);
      expect(historicalVolatility(closes, 20)).toBeCloseTo(0, 5);
    });

    it('is positive for a genuinely noisy series', () => {
      const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 10);
      const vol = historicalVolatility(closes, 20);
      expect(vol).not.toBeNull();
      expect(vol as number).toBeGreaterThan(0);
    });
  });

  describe('volatilityPercentile', () => {
    it('returns null with insufficient lookback history', () => {
      const bars = makeBars(Array.from({ length: 30 }, () => 100));
      expect(volatilityPercentile(bars, 100, 14)).toBeNull();
    });

    it('ranks a real volatility spike near the top of its own history', () => {
      // Calm for a long stretch, then a real, sharp expansion in daily range right at the end.
      const calmBars = makeBars(Array.from({ length: 130 }, () => 100), 0.001);
      const spikeBars = makeBars([100], 0.08);
      const bars = [...calmBars, ...spikeBars];
      const pct = volatilityPercentile(bars, 100, 14);
      expect(pct).not.toBeNull();
      expect(pct as number).toBeGreaterThan(80);
    });
  });

  describe('bollingerBandWidth', () => {
    it('is 0 for a perfectly flat price series (bands collapse to the price)', () => {
      const flat = Array.from({ length: 25 }, () => 100);
      expect(bollingerBandWidth(flat)).toBeCloseTo(0, 8);
    });

    it('is positive for a real, varying series', () => {
      const varying = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i) * 5);
      const width = bollingerBandWidth(varying);
      expect(width).not.toBeNull();
      expect(width as number).toBeGreaterThan(0);
    });
  });

  describe('keltnerChannels', () => {
    it('centers on the EMA with real ATR-based bands', () => {
      const bars = makeBars(Array.from({ length: 30 }, (_, i) => 100 + i));
      const kc = keltnerChannels(bars.map(b => b.high), bars.map(b => b.low), bars.map(b => b.close));
      expect(kc).not.toBeNull();
      expect(kc!.upper).toBeGreaterThan(kc!.middle);
      expect(kc!.lower).toBeLessThan(kc!.middle);
    });

    it('returns null with insufficient history', () => {
      expect(keltnerChannels([1], [1], [1])).toBeNull();
    });
  });

  describe('classifyVolatilityRegime', () => {
    it('detects a real expansion when recent ranges widen sharply vs. the prior average', () => {
      const calmBars = makeBars(Array.from({ length: 35 }, () => 100), 0.002);
      const wideBars = makeBars(Array.from({ length: 5 }, () => 100), 0.05);
      const bars = [...calmBars, ...wideBars];
      expect(classifyVolatilityRegime(bars)).toBe('EXPANDING');
    });

    it('returns STABLE when recent ranges are similar to the prior average', () => {
      const bars = makeBars(Array.from({ length: 40 }, () => 100), 0.01);
      expect(classifyVolatilityRegime(bars)).toBe('STABLE');
    });
  });

  describe('computeVolatilityFeatures', () => {
    it('assembles a real ATR (via the existing TechnicalIndicators.calculateATR) with the new features', () => {
      const bars = makeBars(Array.from({ length: 40 }, (_, i) => 100 + i));
      const features = computeVolatilityFeatures(bars);
      expect(features.atr).toBeGreaterThan(0);
      expect(features.atrPercent).not.toBeNull();
      expect(features.closePriceZScore === null || Number.isFinite(features.closePriceZScore)).toBe(true);
    });
  });
});
