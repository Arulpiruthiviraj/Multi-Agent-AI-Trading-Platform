import { describe, it, expect } from 'vitest';
import { riskRewardRatio, expectedValue, fractionalKelly, MIN_SAMPLE_SIZE_FOR_KELLY, MAX_KELLY_FRACTION_OF_CAPITAL } from './ExpectedValue';

describe('riskRewardRatio', () => {
  it('computes a real 2:1 ratio for a long setup', () => {
    const result = riskRewardRatio(100, 95, 110); // risk 5, reward 10
    expect(result!.ratio).toBe(2);
    expect(result!.riskPerUnit).toBe(5);
    expect(result!.rewardPerUnit).toBe(10);
  });

  it('computes the same ratio magnitude for a short setup (stop above entry, target below)', () => {
    const result = riskRewardRatio(100, 105, 90); // risk 5, reward 10
    expect(result!.ratio).toBe(2);
  });

  it('returns null (never a fabricated infinite ratio) when stop equals entry', () => {
    expect(riskRewardRatio(100, 100, 110)).toBeNull();
  });

  it('returns null for non-finite inputs', () => {
    expect(riskRewardRatio(NaN, 95, 110)).toBeNull();
  });
});

describe('expectedValue', () => {
  it('is positive when win probability * R:R exceeds the loss probability - a real statistical edge', () => {
    const result = expectedValue(0.5, 2); // 0.5*2 - 0.5*1 = 0.5R
    expect(result!.expectedValueR).toBe(0.5);
  });

  it('is negative when the edge is real but unfavorable', () => {
    const result = expectedValue(0.3, 1); // 0.3*1 - 0.7*1 = -0.4R
    expect(result!.expectedValueR).toBe(-0.4);
  });

  it('is exactly zero at true breakeven (win probability = 1/(1+R:R))', () => {
    const result = expectedValue(1 / 3, 2); // breakeven for 2:1 R:R
    expect(result!.expectedValueR).toBeCloseTo(0, 5);
  });

  it('returns null for an invalid probability outside [0,1]', () => {
    expect(expectedValue(1.5, 2)).toBeNull();
    expect(expectedValue(-0.1, 2)).toBeNull();
  });

  it('returns null for a non-positive risk/reward ratio', () => {
    expect(expectedValue(0.5, 0)).toBeNull();
    expect(expectedValue(0.5, -1)).toBeNull();
  });
});

describe('fractionalKelly', () => {
  it('refuses (statistically unjustified) below the minimum real sample size', () => {
    const result = fractionalKelly(0.6, 2, MIN_SAMPLE_SIZE_FOR_KELLY - 1);
    expect(result.statisticallyJustified).toBe(false);
    expect(result.suggestedFraction).toBe(0);
    expect(result.reason).toContain('INSUFFICIENT SAMPLE SIZE');
  });

  it('computes a real positive quarter-Kelly fraction for a genuine statistical edge with enough sample size', () => {
    // p=0.6, b=2 -> full Kelly = (0.6*3 - 1)/2 = 0.4; quarter Kelly = 0.1 -> exactly at the cap
    const result = fractionalKelly(0.6, 2, 50, 0.25);
    expect(result.statisticallyJustified).toBe(true);
    expect(result.fullKellyFraction).toBeCloseTo(0.4, 4);
    expect(result.suggestedFraction).toBeCloseTo(0.1, 4);
  });

  it('hard-caps the suggested fraction at MAX_KELLY_FRACTION_OF_CAPITAL even when fractional Kelly exceeds it', () => {
    // p=0.9, b=3 -> full Kelly = (0.9*4-1)/3 = 0.8667; half-Kelly = 0.4333, way above the 0.10 cap.
    const result = fractionalKelly(0.9, 3, 100, 0.5);
    expect(result.suggestedFraction).toBe(MAX_KELLY_FRACTION_OF_CAPITAL);
    expect(result.reason).toContain('hard cap');
  });

  it('never suggests a positive size when full Kelly itself is non-positive (no real edge), regardless of sample size', () => {
    const result = fractionalKelly(0.3, 1, 100); // p=0.3, b=1 -> full Kelly = (0.3*2-1)/1 = -0.4
    expect(result.statisticallyJustified).toBe(true); // the sample size WAS enough - the edge itself is the problem
    expect(result.fullKellyFraction).toBeLessThan(0);
    expect(result.suggestedFraction).toBe(0);
    expect(result.reason).toContain('no real statistical edge');
  });

  it('never suggests a negative size for invalid probability/ratio input', () => {
    const result = fractionalKelly(1.5, 2, 50);
    expect(result.suggestedFraction).toBe(0);
    expect(result.statisticallyJustified).toBe(false);
  });

  it('defaults to quarter-Kelly (0.25) when no fraction is specified', () => {
    const result = fractionalKelly(0.55, 1.5, 30);
    expect(result.fractionOfFullKelly).toBe(0.25);
  });
});
