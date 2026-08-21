import { describe, it, expect } from 'vitest';
import { agentWeightUpdate, boundedStep } from './agentWeightPolicy';
import { tradingSafety } from '../config/tradingSafety';

describe('agentWeightUpdate', () => {
  it('stays neutral and not statistically meaningful below the trust floor', () => {
    const result = agentWeightUpdate({ totalEvaluated: tradingSafety.minSampleSizeForTrust - 1, winRate: 0.9 });
    expect(result.currentWeight).toBe(1.0);
    expect(result.statisticallyMeaningful).toBe(false);
  });

  it('computes a real weight from win rate once the trust floor is cleared', () => {
    const result = agentWeightUpdate({ totalEvaluated: tradingSafety.minSampleSizeForTrust, winRate: 0.7 });
    expect(result.statisticallyMeaningful).toBe(true);
    expect(result.currentWeight).toBeCloseTo(1.0 + (0.7 - 0.5) * 2, 5);
  });

  it('never returns a weight below the 0.1 floor even for a very poor win rate', () => {
    const result = agentWeightUpdate({ totalEvaluated: tradingSafety.minSampleSizeForTrust, winRate: 0.0 });
    expect(result.currentWeight).toBe(0.1);
  });
});

describe('boundedStep (Phase 8 bounded weight adjustment)', () => {
  it('reaches the target directly when the delta is within the bound', () => {
    expect(boundedStep(1.0, 1.05, 0.15)).toBe(1.05);
  });

  it('clamps to at most maxDelta toward the target when the delta exceeds the bound', () => {
    expect(boundedStep(1.0, 2.0, 0.15)).toBeCloseTo(1.15, 5);
  });

  it('clamps symmetrically in the downward direction', () => {
    expect(boundedStep(1.0, 0.1, 0.15)).toBeCloseTo(0.85, 5);
  });

  it('is a no-op when already at the target', () => {
    expect(boundedStep(1.0, 1.0, 0.15)).toBe(1.0);
  });

  it('requires several consecutive cycles to reach a far-away target - proves one noisy cycle cannot snap the weight', () => {
    let weight = 1.0;
    const target = 1.9; // an extreme, single-cycle-computed target
    const maxDelta = 0.15;
    let cycles = 0;
    while (weight < target && cycles < 100) {
      weight = boundedStep(weight, target, maxDelta);
      cycles++;
    }
    expect(cycles).toBeGreaterThan(1); // did not reach it in one step
    expect(weight).toBe(target); // but does converge given enough consistent cycles
  });
});
