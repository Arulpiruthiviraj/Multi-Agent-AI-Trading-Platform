import { describe, it, expect } from 'vitest';
import { validateStrategy } from './validateStrategy';
import { createStrategy, CreateStrategyInput } from '../core/createStrategy';
import { leaf, and, not } from '../conditions/ConditionTypes';
import { ConditionNode } from '../conditions/ConditionTypes';

function baseInput(overrides: Partial<CreateStrategyInput> = {}): CreateStrategyInput {
  return {
    name: 'Test Strategy',
    family: 'TREND',
    implementationStatus: 'REAL',
    requiredIndicators: ['rsi14'],
    entryConditions: leaf('RSIAbove', { value: 50 }),
    confirmationConditions: null,
    invalidationConditions: null,
    exitConditions: null,
    stopLoss: { kind: 'ATR_MULTIPLE', value: 2, basis: 'test' },
    takeProfit: null,
    positionSizing: { kind: 'FIXED_FRACTIONAL', value: 0.01, basis: 'test' },
    parameters: [],
    parameterValues: {},
    dependencies: [],
    metadata: { description: 'test', tags: ['test'], assetClasses: ['EQUITY'], timeframes: ['1d'], marketRegimes: ['TRENDING_UP'], origin: 'BASE' },
    ...overrides,
  };
}

describe('validateStrategy', () => {
  it('accepts a well-formed strategy', () => {
    const result = validateStrategy(createStrategy(baseInput()));
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects a missing name', () => {
    const s = { ...createStrategy(baseInput()), name: '' };
    expect(validateStrategy(s).valid).toBe(false);
  });

  it('rejects NOT with more than one child', () => {
    const badNot: ConditionNode = { kind: 'composite', op: 'NOT', children: [leaf('Always'), leaf('Never')] };
    const s = { ...createStrategy(baseInput()), entryConditions: badNot };
    const result = validateStrategy(s);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('NOT must have exactly 1 child'))).toBe(true);
  });

  it('rejects an empty composite', () => {
    const empty: ConditionNode = { kind: 'composite', op: 'AND', children: [] };
    const s = { ...createStrategy(baseInput()), entryConditions: empty };
    expect(validateStrategy(s).valid).toBe(false);
  });

  it('detects a real circular condition (self-referencing node)', () => {
    const cyclic: any = { kind: 'composite', op: 'AND', children: [] };
    cyclic.children.push(cyclic); // genuine self-reference
    const s = { ...createStrategy(baseInput()), entryConditions: cyclic };
    const result = validateStrategy(s);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /[Cc]ircular/.test(e.message))).toBe(true);
  });

  it('does not falsely flag two structurally-identical but distinct nodes as circular', () => {
    const a = leaf('RSIAbove', { value: 50 });
    const b = leaf('RSIAbove', { value: 50 }); // same shape, different object
    const s = { ...createStrategy(baseInput()), entryConditions: and(a, b) };
    expect(validateStrategy(s).valid).toBe(true);
  });

  it('rejects invalid parameter ranges', () => {
    const s = {
      ...createStrategy(baseInput()),
      parameters: [{ name: 'bad', type: 'number' as const, range: { min: 10, max: 5, step: 1 }, default: 5 }],
    };
    const result = validateStrategy(s);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('min > range.max'))).toBe(true);
  });

  it('rejects a parameter with neither values nor range', () => {
    const s = {
      ...createStrategy(baseInput()),
      parameters: [{ name: 'empty', type: 'number' as const, default: 5 }],
    };
    expect(validateStrategy(s).valid).toBe(false);
  });

  it('warns (does not error) when only stopLoss provides exit logic', () => {
    const result = validateStrategy(createStrategy(baseInput()));
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.path === 'exitConditions')).toBe(true);
  });

  it('rejects a METADATA_ONLY strategy that is not a BASE origin', () => {
    const s = createStrategy(baseInput({
      implementationStatus: 'METADATA_ONLY',
      metadata: { description: 'x', tags: [], assetClasses: ['EQUITY'], timeframes: ['1d'], marketRegimes: ['TRENDING_UP'], origin: 'GENERATED' },
    }));
    const result = validateStrategy(s);
    expect(result.valid).toBe(false);
  });

  it('accepts a METADATA_ONLY BASE strategy', () => {
    const s = createStrategy(baseInput({
      implementationStatus: 'METADATA_ONLY',
      metadata: { description: 'x', tags: [], assetClasses: ['EQUITY'], timeframes: ['1d'], marketRegimes: ['TRENDING_UP'], origin: 'BASE' },
    }));
    expect(validateStrategy(s).valid).toBe(true);
  });
});
