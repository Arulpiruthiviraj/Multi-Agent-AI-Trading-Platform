import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { validateInstrumentSymbol } from './InstrumentRegistry';
import { seedRuntimeOverrideCacheForTests, resetRuntimeConfigCacheForTests } from '../config/effectiveRuntimeConfig';

describe('validateInstrumentSymbol', () => {
  describe('equity path unchanged (matches looksLikeListedTicker exactly)', () => {
    it('accepts real equity tickers', () => {
      expect(validateInstrumentSymbol('AAPL')).toMatchObject({ valid: true, canonicalSymbol: 'AAPL', assetClass: 'EQUITY' });
      expect(validateInstrumentSymbol('MSFT')).toMatchObject({ valid: true, canonicalSymbol: 'MSFT', assetClass: 'EQUITY' });
      expect(validateInstrumentSymbol('SPY')).toMatchObject({ valid: true, canonicalSymbol: 'SPY', assetClass: 'EQUITY' });
      expect(validateInstrumentSymbol('BRK.B')).toMatchObject({ valid: true, canonicalSymbol: 'BRK.B', assetClass: 'EQUITY' });
      expect(validateInstrumentSymbol('nvda')).toMatchObject({ valid: true, canonicalSymbol: 'NVDA', assetClass: 'EQUITY' });
    });

    it('rejects the same invalid equity inputs looksLikeListedTicker always rejected', () => {
      expect(validateInstrumentSymbol('(Coca-Cola)').valid).toBe(false);
      expect(validateInstrumentSymbol('Apple Inc').valid).toBe(false);
      expect(validateInstrumentSymbol('').valid).toBe(false);
      expect(validateInstrumentSymbol(null).valid).toBe(false);
    });
  });

  // "What to trade" selector (2026-09-22): CRYPTO is disabled by default
  // (ARGUS_TRADEABLE_ASSET_CLASSES defaults to EQUITY-only), so these tests explicitly opt it in
  // to test the crypto validation PATH itself - the default-off behavior is proven separately below.
  describe('crypto path (registry-only, never a permissive regex)', () => {
    beforeAll(() => seedRuntimeOverrideCacheForTests('ARGUS_TRADEABLE_ASSET_CLASSES', 'EQUITY,CRYPTO'));
    afterAll(() => resetRuntimeConfigCacheForTests());

    it('accepts registered canonical crypto instruments', () => {
      expect(validateInstrumentSymbol('BTC-USD')).toMatchObject({ valid: true, canonicalSymbol: 'BTC-USD', assetClass: 'CRYPTO' });
      expect(validateInstrumentSymbol('ETH-USD')).toMatchObject({ valid: true, canonicalSymbol: 'ETH-USD', assetClass: 'CRYPTO' });
      expect(validateInstrumentSymbol('btc-usd')).toMatchObject({ valid: true, canonicalSymbol: 'BTC-USD', assetClass: 'CRYPTO' });
    });

    it('rejects provider-notation variants - canonical symbols only', () => {
      expect(validateInstrumentSymbol('BTC/USD').valid).toBe(false);
      expect(validateInstrumentSymbol('BTCUSD').valid).toBe(false);
      expect(validateInstrumentSymbol('XBTUSD').valid).toBe(false);
    });

    it('rejects malformed crypto-shaped strings', () => {
      expect(validateInstrumentSymbol('BTC--USD').valid).toBe(false);
      expect(validateInstrumentSymbol('BTC-').valid).toBe(false);
      expect(validateInstrumentSymbol('-USD').valid).toBe(false);
    });

    it('rejects an unregistered crypto-shaped symbol - a hyphen alone is never sufficient', () => {
      const result = validateInstrumentSymbol('DOG-FAKE');
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('UNREGISTERED_OR_MALFORMED_SYMBOL');
    });

    it('rejects a random six-letter string (too long for equity, unregistered for crypto)', () => {
      expect(validateInstrumentSymbol('ABCDEF').valid).toBe(false);
    });
  });

  describe('"what to trade" asset-class selector (ARGUS_TRADEABLE_ASSET_CLASSES)', () => {
    afterAll(() => resetRuntimeConfigCacheForTests());

    it('default (unset) is EQUITY-only: a registered crypto instrument fails ASSET_CLASS_NOT_TRADEABLE', () => {
      resetRuntimeConfigCacheForTests();
      const result = validateInstrumentSymbol('BTC-USD');
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('ASSET_CLASS_NOT_TRADEABLE');
      // Equity is unaffected by the default.
      expect(validateInstrumentSymbol('AAPL').valid).toBe(true);
    });

    it('CRYPTO-only disables equity validation entirely', () => {
      seedRuntimeOverrideCacheForTests('ARGUS_TRADEABLE_ASSET_CLASSES', 'CRYPTO');
      expect(validateInstrumentSymbol('AAPL')).toMatchObject({ valid: false, reason: 'ASSET_CLASS_NOT_TRADEABLE' });
      expect(validateInstrumentSymbol('BTC-USD').valid).toBe(true);
    });

    it('EQUITY,CRYPTO enables both', () => {
      seedRuntimeOverrideCacheForTests('ARGUS_TRADEABLE_ASSET_CLASSES', 'EQUITY,CRYPTO');
      expect(validateInstrumentSymbol('AAPL').valid).toBe(true);
      expect(validateInstrumentSymbol('BTC-USD').valid).toBe(true);
    });

    it('an unrecognized token is ignored, not treated as enabling everything', () => {
      seedRuntimeOverrideCacheForTests('ARGUS_TRADEABLE_ASSET_CLASSES', 'FOREX,CRYPTO');
      expect(validateInstrumentSymbol('BTC-USD').valid).toBe(true);
      expect(validateInstrumentSymbol('AAPL').valid).toBe(false);
    });
  });
});
