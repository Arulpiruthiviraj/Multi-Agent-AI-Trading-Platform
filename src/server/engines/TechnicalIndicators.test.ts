import { describe, it, expect } from 'vitest';
import { TechnicalIndicators } from './TechnicalIndicators';

/**
 * Golden-vector correctness suite (2026-09-22, CLI runtime forensics targeted follow-up, Part C -
 * numerical audit prompted by the real MACDEngine EMA-seeding defect found earlier the same
 * session). No prior test file existed for this live-path engine - real consumers include
 * PortfolioMonitor.ts and TrendFollowingExitEvaluator.ts (both live position-exit evaluation) and
 * src/server/quant/indicators/volatility.ts's atrPercent()/keltnerChannels() (which
 * `computeVolatilityFeatures()` already documents as reusing `calculateATR` "not reimplemented").
 *
 * Notable finding from this audit: `calculateEMA` below ALREADY correctly seeds with
 * `calculateSMA(prices.slice(0, period), period)` - the exact convention MACDEngine.calcEMA was
 * missing before its own fix. Two independent EMA implementations existed in this codebase, one
 * correct and one (now-fixed) buggy - a real instance of the split-brain risk CLAUDE.md's own
 * "extend, don't fork" principle warns about, flagged here rather than silently left as two
 * parallel implementations. Not consolidated in this pass: `calculateEMA` returns only the final
 * scalar value, while MACDEngine's internal use needs a full per-index series - a genuine
 * refactor, not a drop-in replacement, and out of scope for a numerical-correctness audit.
 */

describe('TechnicalIndicators (golden-vector verification)', () => {
  describe('calculateSMA', () => {
    it('matches a hand-computed average', () => {
      expect(TechnicalIndicators.calculateSMA([1, 2, 3, 4, 5], 5)).toBe(3);
      expect(TechnicalIndicators.calculateSMA([10, 20, 30], 3)).toBe(20);
    });

    it('uses only the trailing `period` window, not the whole series', () => {
      // Last 3 of [1,2,3,100,200,300] = [100,200,300] -> avg 200.
      expect(TechnicalIndicators.calculateSMA([1, 2, 3, 100, 200, 300], 3)).toBe(200);
    });
  });

  describe('calculateEMA', () => {
    it('seeds with the SMA of the first `period` values (hand-verified), not a single raw price', () => {
      // prices=[1,2,3,4,5], period=3: SMA seed = (1+2+3)/3 = 2 at index 2; multiplier = 2/(3+1) = 0.5.
      // Walking the recursion from the seed over the REMAINING values [4,5]:
      // ema = (4-2)*0.5+2 = 3; ema = (5-3)*0.5+3 = 4. Final scalar returned = 4.
      expect(TechnicalIndicators.calculateEMA([1, 2, 3, 4, 5], 3)).toBeCloseTo(4, 10);
    });

    it('a constant series converges the EMA exactly to that constant', () => {
      expect(TechnicalIndicators.calculateEMA(new Array(30).fill(250), 12)).toBeCloseTo(250, 10);
    });
  });

  describe('calculateATR (Wilder\'s Smoothing True Range)', () => {
    it('matches a hand-computed value for a short, known high/low/close sequence', () => {
      // period=2. True Range formula: max(high-low, |high-prevClose|, |low-prevClose|).
      // Bars (H,L,C): (10,8,9), (11,9,10.5), (12,10,11), (13,11,12.5)
      // TR[1] (i=1, prevClose=9):  max(11-9=2, |11-9|=2, |9-9|=0) = 2
      // TR[2] (i=2, prevClose=10.5): max(12-10=2, |12-10.5|=1.5, |10-10.5|=0.5) = 2
      // TR[3] (i=3, prevClose=11): max(13-11=2, |13-11|=2, |11-11|=0) = 2
      // seed = avg(TR[1],TR[2]) = (2+2)/2 = 2 (first `period`=2 of the 3 TRs)
      // Wilder step for TR[3]=2: atr = ((2*(2-1))+2)/2 = (2+2)/2 = 2
      const highs = [10, 11, 12, 13];
      const lows = [8, 9, 10, 11];
      const closes = [9, 10.5, 11, 12.5];
      expect(TechnicalIndicators.calculateATR(highs, lows, closes, 2)).toBeCloseTo(2, 10);
    });

    it('a perfectly flat OHLC series (no range at all) has zero ATR', () => {
      const flat = new Array(20).fill(100);
      expect(TechnicalIndicators.calculateATR(flat, flat, flat, 14)).toBe(0);
    });

    it('returns 0 (documented insufficient-history contract) with fewer than period+1 bars', () => {
      const short = new Array(5).fill(100);
      expect(TechnicalIndicators.calculateATR(short, short, short, 14)).toBe(0);
    });
  });

  describe('calculateBollingerBands', () => {
    it('matches a hand-computed population-stddev band for a small known series', () => {
      // prices=[2,4,4,4,5,5,7,9], period=8 (the full series). mean=5. population variance:
      // ((2-5)^2+(4-5)^2*3+(5-5)^2*2+(7-5)^2+(9-5)^2)/8 = (9+1+1+1+0+0+4+16)/8 = 32/8 = 4. sd=2.
      const bb = TechnicalIndicators.calculateBollingerBands([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
      expect(bb.middle).toBeCloseTo(5, 10);
      expect(bb.upper).toBeCloseTo(9, 10); // 5 + 2*2
      expect(bb.lower).toBeCloseTo(1, 10); // 5 - 2*2
    });

    it('bands collapse to the price on a perfectly flat series', () => {
      const bb = TechnicalIndicators.calculateBollingerBands(new Array(20).fill(100), 20, 2);
      expect(bb.middle).toBe(100);
      expect(bb.upper).toBe(100);
      expect(bb.lower).toBe(100);
    });
  });

  describe('calculateVWAP', () => {
    it('matches a hand-computed volume-weighted average', () => {
      // (10*100 + 20*300) / (100+300) = (1000+6000)/400 = 17.5
      expect(TechnicalIndicators.calculateVWAP([10, 20], [100, 300])).toBeCloseTo(17.5, 10);
    });

    it('falls back to the last price when total volume is zero (avoids division by zero)', () => {
      expect(TechnicalIndicators.calculateVWAP([10, 20], [0, 0])).toBe(20);
    });
  });
});
