import { describe, it, expect } from 'vitest';
import { computeStrategyId, canonicalize, StrategyIdentityInput } from './id';
import { leaf } from '../conditions/ConditionTypes';

function baseInput(overrides: Partial<StrategyIdentityInput> = {}): StrategyIdentityInput {
  return {
    family: 'TREND',
    name: 'Test Strategy',
    version: 1,
    entryConditions: leaf('RSIAbove', { value: 50 }),
    confirmationConditions: null,
    invalidationConditions: null,
    exitConditions: null,
    stopLoss: { kind: 'ATR_MULTIPLE', value: 2, basis: 'test' },
    takeProfit: null,
    positionSizing: { kind: 'FIXED_FRACTIONAL', value: 0.01, basis: 'test' },
    parameterValues: { rsiThreshold: 50 },
    ...overrides,
  };
}

describe('canonicalize', () => {
  it('produces identical output regardless of key order', () => {
    const a = canonicalize({ b: 1, a: 2, c: { y: 1, x: 2 } });
    const b = canonicalize({ a: 2, c: { x: 2, y: 1 }, b: 1 });
    expect(a).toBe(b);
  });
});

describe('computeStrategyId', () => {
  it('is deterministic - same input always produces the same id', () => {
    const id1 = computeStrategyId(baseInput());
    const id2 = computeStrategyId(baseInput());
    expect(id1).toBe(id2);
  });

  it('changes when parameterValues change', () => {
    const id1 = computeStrategyId(baseInput({ parameterValues: { rsiThreshold: 50 } }));
    const id2 = computeStrategyId(baseInput({ parameterValues: { rsiThreshold: 55 } }));
    expect(id1).not.toBe(id2);
  });

  it('changes when the condition tree changes', () => {
    const id1 = computeStrategyId(baseInput({ entryConditions: leaf('RSIAbove', { value: 50 }) }));
    const id2 = computeStrategyId(baseInput({ entryConditions: leaf('RSIAbove', { value: 60 }) }));
    expect(id1).not.toBe(id2);
  });

  it('changes when version changes', () => {
    const id1 = computeStrategyId(baseInput({ version: 1 }));
    const id2 = computeStrategyId(baseInput({ version: 2 }));
    expect(id1).not.toBe(id2);
  });

  it('is stable under key-order permutation of the underlying objects', () => {
    const a = computeStrategyId(baseInput({
      stopLoss: { kind: 'ATR_MULTIPLE', value: 2, basis: 'test' },
    }));
    const b = computeStrategyId(baseInput({
      stopLoss: { basis: 'test', value: 2, kind: 'ATR_MULTIPLE' },
    }));
    expect(a).toBe(b);
  });

  it('embeds the family prefix and version in a readable id', () => {
    const id = computeStrategyId(baseInput({ family: 'MOMENTUM', name: 'RSI Momentum', version: 3 }));
    expect(id).toMatch(/^STRAT-MOM-RSI-MOMENTUM-[0-9a-f]{8}-V3$/);
  });
});
