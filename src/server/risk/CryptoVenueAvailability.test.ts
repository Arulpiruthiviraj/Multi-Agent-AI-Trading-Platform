import { describe, it, expect } from 'vitest';
import { evaluateCryptoVenueAvailability, isCryptoPaperBrokerAvailable } from './CryptoVenueAvailability';
import { getCryptoInstrument } from '../config/cryptoInstruments';

describe('evaluateCryptoVenueAvailability', () => {
  it('honestly reports no paper crypto broker exists yet', () => {
    expect(isCryptoPaperBrokerAvailable()).toBe(false);
  });

  it('fails INSTRUMENT_NOT_ENABLED when instrument is null (unregistered symbol)', () => {
    const result = evaluateCryptoVenueAvailability({ instrument: null, priceAgeMs: 1000, staleThresholdMs: 300000 });
    expect(result.passed).toBe(false);
    expect(result.reasonCode).toBe('INSTRUMENT_NOT_ENABLED');
  });

  it('fails DATA_SOURCE_UNAVAILABLE when priceAgeMs is null (never ticked)', () => {
    const btc = getCryptoInstrument('BTC-USD')!;
    const result = evaluateCryptoVenueAvailability({ instrument: btc, priceAgeMs: null, staleThresholdMs: 300000 });
    expect(result.passed).toBe(false);
    expect(result.reasonCode).toBe('DATA_SOURCE_UNAVAILABLE');
  });

  it('fails DATA_STALE when priceAgeMs exceeds the threshold', () => {
    const btc = getCryptoInstrument('BTC-USD')!;
    const result = evaluateCryptoVenueAvailability({ instrument: btc, priceAgeMs: 400000, staleThresholdMs: 300000 });
    expect(result.passed).toBe(false);
    expect(result.reasonCode).toBe('DATA_STALE');
  });

  it('fails PAPER_BROKER_UNAVAILABLE when instrument enabled and data fresh, since no broker exists yet', () => {
    const btc = getCryptoInstrument('BTC-USD')!;
    const result = evaluateCryptoVenueAvailability({ instrument: btc, priceAgeMs: 1000, staleThresholdMs: 300000 });
    expect(result.passed).toBe(false);
    expect(result.reasonCode).toBe('PAPER_BROKER_UNAVAILABLE');
  });

  it('checks are ordered: instrument enablement checked before data source', () => {
    const result = evaluateCryptoVenueAvailability({ instrument: null, priceAgeMs: null, staleThresholdMs: 300000 });
    expect(result.reasonCode).toBe('INSTRUMENT_NOT_ENABLED');
  });
});
