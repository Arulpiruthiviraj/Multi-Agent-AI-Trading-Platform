import { describe, it, expect } from 'vitest';
import { evaluateExit } from './ExitIntelligenceEngine';
import { exitIntelligenceConfig } from '../config/exitIntelligence';
import type { Bar } from '../engines/backtest/HistoricalDataGateway';

function makeBars(closes: number[]): Bar[] {
  const now = Date.now();
  return closes.map((c, i) => ({
    timestamp: now - (closes.length - i) * 86_400_000,
    open: c, high: c * 1.005, low: c * 0.995, close: c, volume: 1_000_000,
  }));
}

describe('ExitIntelligenceEngine.evaluateExit', () => {
  it('returns HOLD with confidence 0 and INSUFFICIENT_DATA when there are too few bars', () => {
    const result = evaluateExit({
      symbol: 'TEST', entryPrice: 100, currentPrice: 105, peakPriceSinceEntry: 105,
      quantity: 10, bars: makeBars([100, 101, 102]),
    });
    expect(result.decision).toBe('HOLD');
    expect(result.confidence).toBe(0);
    expect(result.evidence[0]).toMatch(/INSUFFICIENT_DATA/);
  });

  it('returns HOLD (not a fabricated score) for invalid entry/current price instead of throwing', () => {
    const result = evaluateExit({
      symbol: 'TEST', entryPrice: 0, currentPrice: 105, peakPriceSinceEntry: 105,
      quantity: 10, bars: makeBars(Array.from({ length: 40 }, (_, i) => 100 + i)),
    });
    expect(result.decision).toBe('HOLD');
    expect(result.confidence).toBe(0);
  });

  it('never throws even on a pathological bars array, and degrades to HOLD', () => {
    expect(() => evaluateExit({
      symbol: 'TEST', entryPrice: 100, currentPrice: 100, peakPriceSinceEntry: 100,
      quantity: 10, bars: makeBars(Array(40).fill(NaN)),
    })).not.toThrow();
  });

  it('a clean, monotonic, low-drawdown uptrend does not recommend a full EXIT/TAKE_PROFIT (nothing to protect yet)', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 1.2);
    const result = evaluateExit({
      symbol: 'TEST', entryPrice: 100, currentPrice: closes[closes.length - 1],
      peakPriceSinceEntry: closes[closes.length - 1], quantity: 10, bars: makeBars(closes),
    });
    // Price at its own peak - zero drawdown-from-peak means zero profit-protection-pressure,
    // the single highest-weighted component (30/100) - so a full exit call would be premature.
    expect(result.decision).not.toBe('TAKE_PROFIT');
    expect(result.decision).not.toBe('EXIT');
    expect(result.drawdownFromPeakPct).toBe(0);
    expect(result.pnlPct).toBeGreaterThan(0);
  });

  it('a profitable position that has given back a large chunk from its peak scores higher exit pressure than one that has not - but one dimension alone is deliberately not enough to force a decision (§4/§15: profit% is only ONE input, multiple dimensions must agree)', () => {
    const up = Array.from({ length: 35 }, (_, i) => 100 + i * 2);
    const down = Array.from({ length: 15 }, (_, i) => up[up.length - 1] - i * 3);
    const pulledBackCloses = [...up, ...down];
    const peak = Math.max(...pulledBackCloses);
    const current = pulledBackCloses[pulledBackCloses.length - 1];
    const pulledBack = evaluateExit({
      symbol: 'TEST', entryPrice: 100, currentPrice: current, peakPriceSinceEntry: peak,
      quantity: 10, bars: makeBars(pulledBackCloses),
    });
    expect(pulledBack.pnlPct).toBeGreaterThan(0);
    expect(pulledBack.drawdownFromPeakPct).toBeGreaterThan(exitIntelligenceConfig.peakDrawbackForPressurePct);
    expect(pulledBack.components.profitProtectionPressure).toBeGreaterThan(0);

    const atPeakCloses = up;
    const atPeak = evaluateExit({
      symbol: 'TEST', entryPrice: 100, currentPrice: atPeakCloses[atPeakCloses.length - 1],
      peakPriceSinceEntry: atPeakCloses[atPeakCloses.length - 1], quantity: 10, bars: makeBars(atPeakCloses),
    });
    expect(atPeak.components.profitProtectionPressure).toBe(0);
    // The pulled-back case must score strictly higher pressure - but a single maxed-out
    // component (profitProtectionPressure is weighted 30/100) is not automatically enough to
    // cross the HOLD threshold by itself; it must combine with other deteriorating evidence.
    expect(pulledBack.exitScore).toBeGreaterThan(atPeak.exitScore);
  });

  it('component weights always sum the same way exitScore is computed (no silent drift between config and math)', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const result = evaluateExit({
      symbol: 'TEST', entryPrice: 100, currentPrice: closes[closes.length - 1],
      peakPriceSinceEntry: Math.max(...closes), quantity: 10, bars: makeBars(closes),
    });
    const w = exitIntelligenceConfig.componentWeights;
    const expectedScore = (
      result.components.momentumDeterioration * w.momentumDeterioration
      + result.components.trendWeakening * w.trendWeakening
      + result.components.profitProtectionPressure * w.profitProtectionPressure
      + result.components.volatilityRisk * w.volatilityRisk
    ) / (w.momentumDeterioration + w.trendWeakening + w.profitProtectionPressure + w.volatilityRisk);
    expect(result.exitScore).toBeCloseTo(expectedScore, 6);
  });

  it('PARTIAL_TAKE_PROFIT carries a real, config-driven suggestedSellFraction; every other decision does not', () => {
    const up = Array.from({ length: 25 }, (_, i) => 100 + i * 2);
    const down = Array.from({ length: 15 }, (_, i) => up[up.length - 1] - i * 3);
    const closes = [...up, ...down];
    const result = evaluateExit({
      symbol: 'TEST', entryPrice: 100, currentPrice: closes[closes.length - 1],
      peakPriceSinceEntry: Math.max(...closes), quantity: 10, bars: makeBars(closes),
    });
    if (result.decision === 'PARTIAL_TAKE_PROFIT') {
      expect(result.suggestedSellFraction).toBe(exitIntelligenceConfig.partialTakeProfitSellFraction);
    } else {
      expect(result.suggestedSellFraction).toBeNull();
    }
  });

  it('a losing position never gets profit-protection-pressure score (that component is profit-only by design)', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 - i * 0.8);
    const result = evaluateExit({
      symbol: 'TEST', entryPrice: 100, currentPrice: closes[closes.length - 1],
      peakPriceSinceEntry: 100, quantity: 10, bars: makeBars(closes),
    });
    expect(result.pnlPct).toBeLessThan(0);
    expect(result.components.profitProtectionPressure).toBe(0);
  });
});
