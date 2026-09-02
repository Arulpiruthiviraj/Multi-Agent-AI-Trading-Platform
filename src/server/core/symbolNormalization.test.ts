import { describe, it, expect } from 'vitest';
import { normalizeSymbols, normalizeAndValidateSymbols } from './symbolNormalization';

describe('normalizeSymbols', () => {
  it('trims, uppercases, dedupes, and drops empties', () => {
    expect(normalizeSymbols([' aapl ', 'AAPL', 'msft', '', '  ', null, undefined])).toEqual(['AAPL', 'MSFT']);
  });

  it('does not validate ticker shape - garbage strings survive if non-empty', () => {
    expect(normalizeSymbols(['not-a-real-ticker!!!'])).toEqual(['NOT-A-REAL-TICKER!!!']);
  });
});

describe('normalizeAndValidateSymbols', () => {
  it('trims, uppercases, dedupes, and rejects strings that do not look like listed tickers', () => {
    expect(normalizeAndValidateSymbols([' aapl ', 'AAPL', 'msft', 'not-a-real-ticker!!!', ''])).toEqual(['AAPL', 'MSFT']);
  });

  it('returns an empty array when nothing survives validation', () => {
    expect(normalizeAndValidateSymbols(['', '   ', '###', null, undefined])).toEqual([]);
  });
});
