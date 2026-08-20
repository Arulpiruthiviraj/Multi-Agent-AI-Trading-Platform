import { describe, it, expect } from 'vitest';
import { evaluateReplayTechnical } from './replayTechnicalEvaluation';
import { evaluateTechnicalSignals } from '../services/technicalSignal';
import type { ResearchBar } from '../research/ohlcvTypes';

// A prior version of replayTechnicalEvaluation.ts carried its own reimplementation of
// TechnicalAgent's three strategy rules, which had drifted from the real live agent in two
// specific ways: the overbought rule fired at rsi>70 instead of live's rsi>75, and the
// mean-reversion/overbought confidence formulas used RSI alone instead of live's
// (rsiStrength + bbStrength) / 2. This suite proves the current version - which delegates to
// technicalSignal.ts's evaluateTechnicalSignals(), the same function TechnicalAgent.ts itself
// calls - no longer has that drift, and no longer fabricates a "TechnicalAgent" opinion when
// TechnicalAgent's own rules say HOLD.

function barsFromCloses(closes: number[]): ResearchBar[] {
  return closes.map((close, i) => ({
    timestamp: i * 60_000,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
  }));
}

// Flat-ish then a mild recent uptick - lands RSI ~73.5 with price ABOVE the upper Bollinger
// band, i.e. both conditions the old buggy overbought rule (rsi>70 && price>bbUpper) needed to
// fire are true, while the real live rule (rsi>75) still correctly says HOLD. Verified
// empirically against evaluateTechnicalSignals.
function midSpikePrices(n: number, start = 100): number[] {
  const prices: number[] = [];
  for (let i = 0; i < n - 4; i++) prices.push(start + Math.sin(i / 5) * 0.3);
  let p = prices[prices.length - 1];
  for (let i = 0; i < 4; i++) { p += 0.20; prices.push(p); }
  return prices;
}

// Full sharp spike - lands RSI comfortably above 75, so it should fire under both the old and
// new thresholds (this proves the delegation didn't just make overbought unreachable).
function sharpSpikePrices(n: number, start = 100): number[] {
  const prices: number[] = [];
  for (let i = 0; i < n - 5; i++) prices.push(start + Math.sin(i / 5) * 0.5);
  let p = prices[prices.length - 1];
  for (let i = 0; i < 5; i++) { p += 3; prices.push(p); }
  return prices;
}

describe('evaluateReplayTechnical (delegates to technicalSignal.ts - no reimplemented drift)', () => {
  it('matches evaluateTechnicalSignals exactly for a firing momentum breakout', () => {
    const closes: number[] = [];
    let p = 100;
    for (let i = 0; i < 60; i++) { p += (i % 3 === 2) ? -0.9 : 1.0; closes.push(p); }
    const bars = barsFromCloses(closes);
    const replay = evaluateReplayTechnical(bars);
    const live = evaluateTechnicalSignals(closes);

    expect(replay).not.toBeNull();
    expect(live.momentumBreakout).not.toBeNull();
    expect(replay!.side).toBe(live.momentumBreakout!.side);
    expect(replay!.confidence).toBe(live.momentumBreakout!.confidence);
    expect(replay!.rsi).toBeCloseTo(live.indicators.rsi, 10);
  });

  it('does NOT fire overbought at RSI 71-74 (the old reimplementation used rsi>70 and would have)', () => {
    const closes = midSpikePrices(60);
    const bars = barsFromCloses(closes);
    const replay = evaluateReplayTechnical(bars);
    const live = evaluateTechnicalSignals(closes);

    expect(replay).not.toBeNull();
    // Pin the setup: this case is only meaningful if RSI is in the 71-74 gap between the old
    // buggy threshold (70) and the real live threshold (75), AND price is above the upper
    // Bollinger band - i.e. both conditions the old reimplementation's overbought rule needed
    // (rsi>70 && currentPrice>bbUpper) are satisfied here, so it would have fired.
    expect(replay!.rsi).toBeGreaterThan(70);
    expect(replay!.rsi).toBeLessThan(75);
    expect(replay!.currentPrice).toBeGreaterThan(replay!.bbUpper);
    expect(live.overbought).toBeNull();
    expect(replay!.side).toBe('HOLD');
    expect(replay!.confidence).toBe(0);
  });

  it('fires overbought at RSI > 75 with the real (rsiStrength + bbStrength) / 2 confidence, not an RSI-only formula', () => {
    const closes = sharpSpikePrices(60);
    const bars = barsFromCloses(closes);
    const replay = evaluateReplayTechnical(bars);
    const live = evaluateTechnicalSignals(closes);

    expect(replay).not.toBeNull();
    expect(replay!.rsi).toBeGreaterThan(75);
    expect(live.overbought).not.toBeNull();
    expect(replay!.side).toBe('SELL');
    expect(replay!.confidence).toBe(live.overbought!.confidence);

    // The old RSI-only formula was clamp01((rsi-70)/30) -> strengthToConfidence(...). Prove the
    // real formula (which also incorporates bbStrength) is not numerically equivalent to it.
    const oldBuggyConfidence = Number((0.55 + 0.40 * Math.max(0, Math.min(1, (replay!.rsi - 70) / 30))).toFixed(3));
    expect(replay!.confidence).not.toBe(oldBuggyConfidence);
  });

  it('contributes no fabricated vote when TechnicalAgent HOLDs (mirrors live: no signal, no idea)', () => {
    const flat = Array.from({ length: 60 }, () => 100);
    const bars = barsFromCloses(flat);
    const replay = evaluateReplayTechnical(bars);

    expect(replay).not.toBeNull();
    expect(replay!.side).toBe('HOLD');
    expect(replay!.confidence).toBe(0);
  });
});
