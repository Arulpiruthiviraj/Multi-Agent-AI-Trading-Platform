import { describe, it, expect } from 'vitest';
import { isPlausibleHistoricalSymbol, isCanonicalStoredSymbol } from './symbolFormat';

describe('isPlausibleHistoricalSymbol', () => {
  it('rejects strings that can never be a ticker: whitespace, headline text, punctuation, empty, non-strings', () => {
    for (const bad of ['ARCHER AVIATION', ' ARCHER AVIATION', 'Intel Corp announces earnings', 'THE FED', 'SMSC LTD', '', ' ', 'A B', 'AAPL!', 'SOMETHINGABSURDLYLONGNAME', null, undefined, 42]) {
      expect(isPlausibleHistoricalSymbol(bad as any), String(bad)).toBe(false);
    }
  });
  it('keeps legitimate instruments valid (plain, share class, ETF, pair-style)', () => {
    for (const ok of ['AAPL', 'brk.b', 'BRK.B', 'BF-B', 'SQQQ', 'C', 'GLD', 'S', 'BTC/USD', 'RDS.A']) {
      expect(isPlausibleHistoricalSymbol(ok), ok).toBe(true);
    }
  });
  it('plain-letter company names pass the format gate by design (a format check cannot know INTEL is not a ticker) - the IBKR code-200 negative cache handles them', () => {
    expect(isPlausibleHistoricalSymbol('INTEL')).toBe(true);
    expect(isPlausibleHistoricalSymbol('WALMART')).toBe(true);
  });
});

describe('isCanonicalStoredSymbol (rows read back from storage)', () => {
  it('rejects the legacy Aug-10 transactions symbols that were re-sent to IBKR every cycle', () => {
    for (const bad of ['Walmart', ' Archer Aviation', 'Intel', 'smsc']) expect(isCanonicalStoredSymbol(bad), bad).toBe(false);
  });
  it('accepts normalized upper-case tickers', () => {
    for (const ok of ['AAPL', 'BRK.B', 'SQQQ', 'NVDA']) expect(isCanonicalStoredSymbol(ok), ok).toBe(true);
  });
});
