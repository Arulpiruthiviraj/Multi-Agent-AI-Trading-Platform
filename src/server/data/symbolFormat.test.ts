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

import { classifyEquityRouting, isRoutableEquitySymbol } from './symbolFormat';

describe('classifyEquityRouting (Oct 13 audit: the exact identifiers that earned IBKR code-200 rejections)', () => {
  it.each([
    ['NULL', 'RESERVED_PLACEHOLDER'], ['NONE', 'RESERVED_PLACEHOLDER'], ['UNDEFINED', 'RESERVED_PLACEHOLDER'],
    ['DIAGTEST1786368993694', 'TEST_ONLY_DIAGNOSTIC'], ['DIAGPIPE1786370354218', 'TEST_ONLY_DIAGNOSTIC'],
    ['USDJPY', 'FX_PAIR'], ['EURUSD', 'FX_PAIR'], ['SPX', 'CASH_INDEX'], ['VIX', 'CASH_INDEX'],
    ['NUSCALE POWER INC.', 'MALFORMED'], ['NONE SPECIFIED, BUT IMPLIES NUSCALE POWER (NSP)', 'MALFORMED'], [' Archer Aviation', 'MALFORMED'],
  ])('%s is not routable (%s)', (symbol, reason) => {
    expect(classifyEquityRouting(symbol)).toEqual({ routable: false, reason });
  });
  it('rejects non-strings', () => {
    expect(classifyEquityRouting(null)).toEqual({ routable: false, reason: 'NOT_A_STRING' });
    expect(classifyEquityRouting(42 as any)).toEqual({ routable: false, reason: 'NOT_A_STRING' });
  });
  it('does NOT over-restrict legitimate tickers, share classes, ETFs, or look-alikes', () => {
    for (const ok of ['AAPL', 'SPY', 'QQQ', 'BRK.B', 'BF-B', 'BRK.A', 'GLD', 'TQQQ', 'SQQQ', 'SOXL', 'S', 'F', 'T', 'NIO', 'USD', 'SPXL', 'SPXS', 'VIXY', 'NDXT', 'UVXY', 'NOW', 'NONEXISTENT1']) {
      expect(isRoutableEquitySymbol(ok), ok).toBe(true);
    }
  });
});
