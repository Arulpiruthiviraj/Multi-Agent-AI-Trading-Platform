import { describe, it, expect, afterEach } from 'vitest';
import { getTradeableAssetClasses, isAssetClassTradeable } from './tradeableAssetClasses';
import { seedRuntimeOverrideCacheForTests, resetRuntimeConfigCacheForTests } from './effectiveRuntimeConfig';

describe('tradeableAssetClasses', () => {
  afterEach(() => resetRuntimeConfigCacheForTests());

  it('defaults to EQUITY-only', () => {
    resetRuntimeConfigCacheForTests();
    expect(getTradeableAssetClasses()).toEqual(new Set(['EQUITY']));
    expect(isAssetClassTradeable('EQUITY')).toBe(true);
    expect(isAssetClassTradeable('CRYPTO')).toBe(false);
  });

  it('CRYPTO alone excludes EQUITY', () => {
    seedRuntimeOverrideCacheForTests('ARGUS_TRADEABLE_ASSET_CLASSES', 'CRYPTO');
    expect(getTradeableAssetClasses()).toEqual(new Set(['CRYPTO']));
    expect(isAssetClassTradeable('EQUITY')).toBe(false);
  });

  it('EQUITY,CRYPTO enables both', () => {
    seedRuntimeOverrideCacheForTests('ARGUS_TRADEABLE_ASSET_CLASSES', 'EQUITY,CRYPTO');
    expect(getTradeableAssetClasses()).toEqual(new Set(['EQUITY', 'CRYPTO']));
  });

  it('is case-insensitive and tolerates whitespace', () => {
    seedRuntimeOverrideCacheForTests('ARGUS_TRADEABLE_ASSET_CLASSES', ' equity , crypto ');
    expect(getTradeableAssetClasses()).toEqual(new Set(['EQUITY', 'CRYPTO']));
  });

  it('ignores unrecognized tokens rather than enabling everything', () => {
    seedRuntimeOverrideCacheForTests('ARGUS_TRADEABLE_ASSET_CLASSES', 'FOREX,BOND');
    // No recognized token survives -> falls back to the safe EQUITY-only default, never "nothing
    // restricted"/"everything enabled".
    expect(getTradeableAssetClasses()).toEqual(new Set(['EQUITY']));
  });

  it('an empty override string falls back to the safe EQUITY-only default', () => {
    seedRuntimeOverrideCacheForTests('ARGUS_TRADEABLE_ASSET_CLASSES', '');
    expect(getTradeableAssetClasses()).toEqual(new Set(['EQUITY']));
  });
});
