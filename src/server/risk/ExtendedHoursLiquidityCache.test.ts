import { describe, it, expect, afterEach } from 'vitest';
import {
  getCachedAvgDailyVolumeShares,
  resetExtendedHoursLiquidityCacheForTests,
  setCachedAvgDailyVolumeSharesForTests,
} from './ExtendedHoursLiquidityCache';
import { continuousIntelligence } from '../config/continuousIntelligence';

/**
 * 2026-10-01 defect verification pass (finding A2.4): previously, once a symbol had ANY
 * successfully-fetched entry, getCachedAvgDailyVolumeShares() returned it forever regardless of
 * age - a background refresh that kept silently failing (e.g. a persistent network issue) meant
 * gate 25 (extended_hours_execution_policy) would keep evaluating against arbitrarily old ADV data
 * instead of ever failing closed again after the first successful fetch. These tests prove the new
 * hard staleness ceiling (extendedHoursLiquidityCacheMaxStaleMs) actually fails closed.
 */
describe('ExtendedHoursLiquidityCache - staleness ceiling (finding A2.4)', () => {
  afterEach(() => {
    resetExtendedHoursLiquidityCacheForTests();
  });

  it('returns null (fail closed) when a symbol has never been fetched', () => {
    expect(getCachedAvgDailyVolumeShares('NEVERFETCHED')).toBeNull();
  });

  it('returns the real cached value when the entry is fresh', () => {
    setCachedAvgDailyVolumeSharesForTests('AAPL', 5_000_000, Date.now());
    expect(getCachedAvgDailyVolumeShares('AAPL')).toBe(5_000_000);
  });

  it('still returns the value when stale past the soft TTL but within the hard ceiling (background refresh pending, old value still usable)', () => {
    const now = Date.now();
    const softlyStaleAt = now - (continuousIntelligence.broadUniverseAssetsCacheTtlMs + 1000);
    setCachedAvgDailyVolumeSharesForTests('MSFT', 3_000_000, softlyStaleAt);
    expect(getCachedAvgDailyVolumeShares('MSFT', new Date(now))).toBe(3_000_000);
  });

  it('fails closed (returns null) once an entry is older than the hard staleness ceiling, even though it was once successfully fetched', () => {
    const now = Date.now();
    const hardStaleAt = now - (continuousIntelligence.extendedHoursLiquidityCacheMaxStaleMs + 1000);
    setCachedAvgDailyVolumeSharesForTests('NVDA', 10_000_000, hardStaleAt);
    expect(getCachedAvgDailyVolumeShares('NVDA', new Date(now))).toBeNull();
  });

  it('the hard ceiling is strictly looser than the soft TTL (sanity check on the two configured values themselves)', () => {
    expect(continuousIntelligence.extendedHoursLiquidityCacheMaxStaleMs).toBeGreaterThan(continuousIntelligence.broadUniverseAssetsCacheTtlMs);
  });
});
