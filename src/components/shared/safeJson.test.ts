import { describe, expect, it } from 'vitest';
import { safeParseSymbols, safeParseJson } from './safeJson';

describe('safeParseSymbols', () => {
  it('parses a JSON array string', () => {
    expect(safeParseSymbols('["AAPL","MSFT"]')).toEqual(['AAPL', 'MSFT']);
  });
  it('treats a bare ticker as one symbol', () => {
    expect(safeParseSymbols('AAPL')).toEqual(['AAPL']);
  });
  it('treats a JSON-encoded bare string as one symbol', () => {
    expect(safeParseSymbols('"AAPL"')).toEqual(['AAPL']);
  });
  it('returns [] for null/undefined/empty', () => {
    expect(safeParseSymbols(null)).toEqual([]);
    expect(safeParseSymbols(undefined)).toEqual([]);
    expect(safeParseSymbols('')).toEqual([]);
    expect(safeParseSymbols('   ')).toEqual([]);
  });
  it('never throws on garbage', () => {
    expect(safeParseSymbols('{not json')).toEqual([]);
    expect(safeParseSymbols('{"a":1}')).toEqual([]);
    expect(safeParseSymbols('[1,2,3]')).toEqual([]);
  });
  it('filters non-strings from arrays', () => {
    expect(safeParseSymbols('["AAPL", 42, null]')).toEqual(['AAPL']);
  });
  it('passes through real arrays', () => {
    expect(safeParseSymbols(['AAPL', 'MSFT'])).toEqual(['AAPL', 'MSFT']);
  });
});

describe('safeParseJson', () => {
  it('parses valid JSON', () => {
    expect(safeParseJson('{"a":1}', {})).toEqual({ a: 1 });
  });
  it('returns fallback on invalid JSON without throwing', () => {
    expect(safeParseJson('oops', { d: 1 })).toEqual({ d: 1 });
  });
});
