import { describe, it, expect } from 'vitest';
import { evaluateTechnicalSignals, calcSMA, calcBollingerBands, strengthToConfidence, clamp01 } from './technicalSignal';

// Deterministic synthetic price series covering each of TechnicalAgent's three real strategies.
// Long enough to satisfy quantThresholds.technicalHistoryBars / the 50-period SMA the momentum
// rule needs.
function risingTrendPrices(n: number, start = 100): number[] {
  // A pure monotonic uptrend pins RSI near 100 (fails the momentum rule's rsi<70 condition).
  // Verified empirically (scratch script against the real evaluateTechnicalSignals): two up-ticks
  // per one larger down-tick lands RSI ~66-67, inside the 50-70 "healthy uptrend" band the
  // momentum-breakout rule targets, while keeping sma20>sma50 and MACD bullish.
  const prices: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p += (i % 3 === 2) ? -0.9 : 1.0;
    prices.push(p);
  }
  return prices;
}

function sharpDropPrices(n: number, start = 100): number[] {
  // Flat-ish then a sharp recent drop, to trigger oversold (RSI<30, price<lower Bollinger band).
  const prices: number[] = [];
  for (let i = 0; i < n - 5; i++) prices.push(start + Math.sin(i / 5) * 0.5);
  let p = prices[prices.length - 1];
  for (let i = 0; i < 5; i++) { p -= 3; prices.push(p); }
  return prices;
}

function sharpSpikePrices(n: number, start = 100): number[] {
  // Flat-ish then a sharp recent spike, to trigger overbought (RSI>75, price>upper Bollinger band).
  const prices: number[] = [];
  for (let i = 0; i < n - 5; i++) prices.push(start + Math.sin(i / 5) * 0.5);
  let p = prices[prices.length - 1];
  for (let i = 0; i < 5; i++) { p += 3; prices.push(p); }
  return prices;
}

describe('evaluateTechnicalSignals (extracted from TechnicalAgent.checkStrategies - real logic, not a proxy)', () => {
  it('fires momentumBreakout (BUY) on a sustained uptrend, with confidence in [0.55, 0.95]', () => {
    const result = evaluateTechnicalSignals(risingTrendPrices(60));
    expect(result.momentumBreakout).not.toBeNull();
    expect(result.momentumBreakout!.side).toBe('BUY');
    expect(result.momentumBreakout!.confidence).toBeGreaterThanOrEqual(0.55);
    expect(result.momentumBreakout!.confidence).toBeLessThanOrEqual(0.95);
    expect(result.meanReversion).toBeNull();
    expect(result.overbought).toBeNull();
  });

  it('fires meanReversion (BUY) on an oversold drop, with confidence in [0.55, 0.95]', () => {
    const result = evaluateTechnicalSignals(sharpDropPrices(60));
    expect(result.meanReversion).not.toBeNull();
    expect(result.meanReversion!.side).toBe('BUY');
    expect(result.meanReversion!.confidence).toBeGreaterThanOrEqual(0.55);
    expect(result.meanReversion!.confidence).toBeLessThanOrEqual(0.95);
  });

  it('fires overbought (SELL) on a sharp spike, with confidence in [0.55, 0.95]', () => {
    const result = evaluateTechnicalSignals(sharpSpikePrices(60));
    expect(result.overbought).not.toBeNull();
    expect(result.overbought!.side).toBe('SELL');
    expect(result.overbought!.confidence).toBeGreaterThanOrEqual(0.55);
    expect(result.overbought!.confidence).toBeLessThanOrEqual(0.95);
  });

  it('fires nothing on a flat, directionless series', () => {
    const flat = Array.from({ length: 60 }, () => 100);
    const result = evaluateTechnicalSignals(flat);
    expect(result.momentumBreakout).toBeNull();
    expect(result.meanReversion).toBeNull();
    expect(result.overbought).toBeNull();
  });

  it('helper functions match the exact formulas TechnicalAgent.ts used before extraction', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(0.3)).toBe(0.3);
    expect(strengthToConfidence(0)).toBe(0.55);
    expect(strengthToConfidence(1)).toBe(0.95);
    expect(strengthToConfidence(0.5)).toBe(0.75);
    expect(calcSMA([1, 2, 3, 4, 5], 5)).toBe(3);
    const bb = calcBollingerBands([1, 2, 3, 4, 5], 5);
    expect(bb.upper).toBeGreaterThan(bb.lower);
  });
});
