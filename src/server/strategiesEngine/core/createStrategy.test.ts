import { describe, it, expect } from 'vitest';
import { createStrategy, bumpVersion, CreateStrategyInput } from './createStrategy';
import { leaf } from '../conditions/ConditionTypes';

function input(overrides: Partial<CreateStrategyInput> = {}): CreateStrategyInput {
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
    metadata: {
      description: 'test', tags: ['test'], assetClasses: ['EQUITY'], timeframes: ['1d'],
      marketRegimes: ['TRENDING_UP'], origin: 'BASE',
    },
    ...overrides,
  };
}

describe('createStrategy', () => {
  it('defaults version to 1 and stamps createdAt', () => {
    const s = createStrategy(input());
    expect(s.version).toBe(1);
    expect(s.metadata.createdAt).toBeTruthy();
    expect(new Date(s.metadata.createdAt).toString()).not.toBe('Invalid Date');
  });

  it('assigns a deterministic id matching core/id.ts', () => {
    const a = createStrategy(input());
    const b = createStrategy(input());
    // Both created "now" - createdAt differs but id excludes createdAt from the hash, so ids match.
    expect(a.id).toBe(b.id);
  });

  it('returns a frozen (immutable) object', () => {
    const s = createStrategy(input());
    expect(Object.isFrozen(s)).toBe(true);
    expect(() => { (s as any).name = 'mutated'; }).toThrow();
  });

  it('two strategies with different names get different ids', () => {
    const a = createStrategy(input({ name: 'Strategy A' }));
    const b = createStrategy(input({ name: 'Strategy B' }));
    expect(a.id).not.toBe(b.id);
  });
});

describe('bumpVersion', () => {
  it('produces a NEW object, never mutates the original', () => {
    const original = createStrategy(input());
    const bumped = bumpVersion(original, { name: 'Renamed Strategy' });
    expect(original.name).toBe('Test Strategy');
    expect(bumped.name).toBe('Renamed Strategy');
    expect(original).not.toBe(bumped);
  });

  it('increments version and changes the id', () => {
    const original = createStrategy(input());
    const bumped = bumpVersion(original);
    expect(bumped.version).toBe(original.version + 1);
    expect(bumped.id).not.toBe(original.id);
  });

  it('records derivedFromId pointing at the original', () => {
    const original = createStrategy(input());
    const bumped = bumpVersion(original);
    expect(bumped.metadata.derivedFromId).toBe(original.id);
  });

  it('a no-op bump still produces a distinct, valid new version', () => {
    const original = createStrategy(input());
    const bumped = bumpVersion(original, {});
    expect(bumped.version).toBe(2);
    expect(bumped.entryConditions).toEqual(original.entryConditions);
  });
});
