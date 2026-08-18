import { describe, it, expect, beforeEach } from 'vitest';
import { StrategyRegistry, DuplicateStrategyError, InvalidStrategyError } from './StrategyRegistry';
import { createStrategy, CreateStrategyInput } from '../core/createStrategy';
import { leaf } from '../conditions/ConditionTypes';
import { StrategyDefinition } from '../core/types';

function makeStrategy(overrides: Partial<CreateStrategyInput> = {}): StrategyDefinition {
  return createStrategy({
    name: overrides.name ?? 'Test Strategy',
    family: overrides.family ?? 'TREND',
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
      description: 'test', tags: overrides.metadata?.tags ?? ['test'], assetClasses: ['EQUITY'],
      timeframes: ['1d'], marketRegimes: ['TRENDING_UP'], origin: 'BASE',
    },
    ...overrides,
  });
}

describe('StrategyRegistry', () => {
  let registry: StrategyRegistry;
  beforeEach(() => { registry = new StrategyRegistry(); });

  it('registers and retrieves by id', () => {
    const s = makeStrategy();
    registry.register(s);
    expect(registry.get(s.id)).toEqual(s);
    expect(registry.exists(s.id)).toBe(true);
    expect(registry.count()).toBe(1);
  });

  it('rejects a duplicate id', () => {
    const s = makeStrategy();
    registry.register(s);
    expect(() => registry.register(s)).toThrow(DuplicateStrategyError);
  });

  it('rejects an invalid strategy (empty entryConditions)', () => {
    const invalid = { ...makeStrategy(), entryConditions: undefined } as any;
    expect(() => registry.register(invalid)).toThrow(InvalidStrategyError);
  });

  it('removes a strategy', () => {
    const s = makeStrategy();
    registry.register(s);
    expect(registry.remove(s.id)).toBe(true);
    expect(registry.exists(s.id)).toBe(false);
    expect(registry.remove(s.id)).toBe(false);
  });

  it('getByFamily returns only that family', () => {
    const trend = makeStrategy({ name: 'A', family: 'TREND' });
    const momentum = makeStrategy({ name: 'B', family: 'MOMENTUM' });
    registry.registerMany([trend, momentum]);
    expect(registry.getByFamily('TREND').map(s => s.id)).toEqual([trend.id]);
  });

  it('getByTag returns matches across families', () => {
    const a = makeStrategy({ name: 'A', metadata: { description: 'x', tags: ['shared'], assetClasses: ['EQUITY'], timeframes: ['1d'], marketRegimes: ['TRENDING_UP'], origin: 'BASE' } });
    const b = makeStrategy({ name: 'B', metadata: { description: 'x', tags: ['shared'], assetClasses: ['EQUITY'], timeframes: ['1d'], marketRegimes: ['TRENDING_UP'], origin: 'BASE' } });
    registry.registerMany([a, b]);
    expect(registry.getByTag('shared').length).toBe(2);
  });

  it('search combines multiple criteria', () => {
    const a = makeStrategy({ name: 'Alpha Trend', family: 'TREND' });
    const b = makeStrategy({ name: 'Beta Trend', family: 'TREND' });
    const c = makeStrategy({ name: 'Gamma Momentum', family: 'MOMENTUM' });
    registry.registerMany([a, b, c]);
    const found = registry.search({ family: 'TREND', namePattern: /^Alpha/ });
    expect(found.map(s => s.id)).toEqual([a.id]);
  });

  it('versions() returns all versions of a lineage oldest-first', () => {
    const v1 = makeStrategy({ name: 'Lineage' });
    const v2 = createStrategy({ ...v1, version: 2, metadata: { ...v1.metadata } });
    registry.registerMany([v1, v2]);
    const versions = registry.versions({ family: 'TREND', name: 'Lineage' });
    expect(versions.map(v => v.version)).toEqual([1, 2]);
  });

  it('registerMany reports skipped duplicates without throwing', () => {
    const s = makeStrategy();
    const { registered, skipped } = registry.registerMany([s, s]);
    expect(registered.length).toBe(1);
    expect(skipped.length).toBe(1);
  });

  it('listAll/listFamilies/clear', () => {
    registry.registerMany([makeStrategy({ name: 'A', family: 'TREND' }), makeStrategy({ name: 'B', family: 'MOMENTUM' })]);
    expect(registry.listAll().length).toBe(2);
    expect(registry.listFamilies().sort()).toEqual(['MOMENTUM', 'TREND']);
    registry.clear();
    expect(registry.count()).toBe(0);
  });
});
