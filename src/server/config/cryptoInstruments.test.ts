import { describe, it, expect } from 'vitest';
import { getCryptoInstrument, isRegisteredCryptoInstrument, listCryptoInstruments } from './cryptoInstruments';

describe('cryptoInstruments registry', () => {
  it('registers BTC-USD and ETH-USD, enabled for research and paper', () => {
    const btc = getCryptoInstrument('BTC-USD');
    expect(btc).not.toBeNull();
    expect(btc?.assetClass).toBe('CRYPTO');
    expect(btc?.baseAsset).toBe('BTC');
    expect(btc?.quoteAsset).toBe('USD');
    expect(btc?.enabledForResearch).toBe(true);
    expect(btc?.enabledForPaper).toBe(true);
    expect(btc?.quantityStep).toBeGreaterThan(0);
    expect(btc?.minimumQuantity).toBeGreaterThan(0);
    expect(btc?.minimumNotional).toBeGreaterThan(0);

    const eth = getCryptoInstrument('ETH-USD');
    expect(eth).not.toBeNull();
    expect(eth?.baseAsset).toBe('ETH');
  });

  it('is case-insensitive on lookup but stores canonical uppercase symbols', () => {
    expect(getCryptoInstrument('btc-usd')?.canonicalSymbol).toBe('BTC-USD');
  });

  it('returns null for anything unregistered, including equities and provider-notation variants', () => {
    expect(getCryptoInstrument('AAPL')).toBeNull();
    expect(getCryptoInstrument('BTC/USD')).toBeNull();
    expect(getCryptoInstrument('BTCUSD')).toBeNull();
    expect(getCryptoInstrument('DOG-FAKE')).toBeNull();
  });

  it('isRegisteredCryptoInstrument matches getCryptoInstrument', () => {
    expect(isRegisteredCryptoInstrument('BTC-USD')).toBe(true);
    expect(isRegisteredCryptoInstrument('AAPL')).toBe(false);
  });

  it('listCryptoInstruments returns exactly the registered set (Phase 1: BTC-USD, ETH-USD only)', () => {
    const list = listCryptoInstruments();
    const symbols = list.map((i) => i.canonicalSymbol).sort();
    expect(symbols).toEqual(['BTC-USD', 'ETH-USD']);
  });
});
