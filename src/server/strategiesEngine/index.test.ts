import { describe, it, expect } from 'vitest';
import {
  defaultRegistry, getEngineStats, generateStrategies, findStrategies, getStrategyCount,
  listStrategyFamilies, StrategyRegistry,
} from './index';
import { BASE_STRATEGIES, METADATA_ONLY_FAMILIES } from './families/catalog';

describe('Strategies Engine public API', () => {
  it('defaultRegistry is pre-seeded with every real base strategy', () => {
    expect(getStrategyCount()).toBe(BASE_STRATEGIES.length);
    for (const base of BASE_STRATEGIES) {
      expect(defaultRegistry.exists(base.id)).toBe(true);
    }
  });

  it('getEngineStats reports real, non-fabricated counts (Section 27)', () => {
    const stats = getEngineStats();
    expect(stats.baseStrategies).toBe(BASE_STRATEGIES.length);
    expect(stats.baseStrategies).toBeGreaterThan(0);
    expect(stats.metadataOnlyFamilies).toBe(METADATA_ONLY_FAMILIES.length);
    expect(stats.conditionPrimitives).toBeGreaterThan(0);
    expect(stats.totalVariantSpaceSize).toBeGreaterThanOrEqual(10_000);
  });

  it('listStrategyFamilies reflects only families with an actual registered strategy', () => {
    const families = listStrategyFamilies();
    expect(families.length).toBeGreaterThan(0);
    expect(new Set(families).size).toBe(families.length); // no duplicates
  });

  it('findStrategies searches the default registry', () => {
    const trendStrategies = findStrategies({ family: 'TREND' });
    expect(trendStrategies.every(s => s.family === 'TREND')).toBe(true);
    expect(trendStrategies.length).toBeGreaterThan(0);
  });

  it('generateStrategies populates an independent registry without touching defaultRegistry', () => {
    const isolated = new StrategyRegistry();
    const before = getStrategyCount();
    const result = generateStrategies({ limit: 50 }, isolated);
    expect(result.generated.length).toBe(50);
    expect(isolated.count()).toBe(50);
    expect(getStrategyCount()).toBe(before); // defaultRegistry untouched
  });

  it('every METADATA_ONLY family carries a real, non-empty reason', () => {
    for (const entry of METADATA_ONLY_FAMILIES) {
      expect(entry.reason.length).toBeGreaterThan(10);
    }
  });
});
