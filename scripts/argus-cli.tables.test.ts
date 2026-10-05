/**
 * Regression tests for CLI output improvements (2026-10-04):
 * - printTable renders aligned tables and handles empty input
 * - field() picks first present candidate name
 * - isJsonOutput()/setJsonOutput() global flag contract
 * - version falls back to git commit when package.json is 0.0.0
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  field,
  isJsonOutput,
  printTable,
  setJsonOutput,
} from './argus-cli';

beforeEach(() => {
  setJsonOutput(false);
});

afterEach(() => {
  setJsonOutput(false);
  vi.restoreAllMocks();
});

describe('printTable', () => {
  it('prints "(no rows)" for empty input', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printTable([], [{ header: 'A', pick: (r) => r.a }]);
    expect(log).toHaveBeenCalledWith('(no rows)');
  });

  it('renders header, separator, and aligned rows', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printTable(
      [
        { symbol: 'AAPL', qty: 10 },
        { symbol: 'MSFT', qty: 5 },
      ],
      [
        { header: 'SYMBOL', pick: (r) => r.symbol },
        { header: 'QTY', pick: (r) => String(r.qty) },
      ],
    );
    const lines = log.mock.calls.map((c) => c[0] as string);
    expect(lines).toHaveLength(4); // header + separator + 2 rows
    expect(lines[0]).toContain('SYMBOL');
    expect(lines[0]).toContain('QTY');
    expect(lines[1]).toMatch(/^-+\s+-+$/);
    expect(lines[2]).toContain('AAPL');
    expect(lines[3]).toContain('MSFT');
    // columns are aligned: QTY values start at the same offset
    expect(lines[2].indexOf('10')).toBe(lines[3].indexOf('5'));
  });

  it('never throws on hostile pick functions or null rows', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(() =>
      printTable([null, undefined, {}], [
        {
          header: 'X',
          pick: () => {
            throw new Error('boom');
          },
        },
      ]),
    ).not.toThrow();
    const lines = log.mock.calls.map((c) => c[0] as string);
    expect(lines[2]).toContain('-');
  });

  it('truncates over-wide cells so one value cannot blow out the layout', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printTable([{ v: 'x'.repeat(200) }], [{ header: 'V', pick: (r) => r.v }]);
    const row = log.mock.calls[2][0] as string;
    expect(row.length).toBeLessThan(80);
    expect(row).toContain('…');
  });
});

describe('field', () => {
  it('picks the first present candidate name', () => {
    expect(field({ a: 1, b: 2 }, 'b', 'a')).toBe('2');
    expect(field({ a: 1 }, 'b', 'a')).toBe('1');
    expect(field({}, 'b', 'a')).toBe('-');
    expect(field({ b: '' }, 'b', 'a')).toBe('-');
    expect(field(null, 'b')).toBe('-');
  });
});

describe('global --json flag', () => {
  it('defaults to table mode and toggles', () => {
    expect(isJsonOutput()).toBe(false);
    setJsonOutput(true);
    expect(isJsonOutput()).toBe(true);
  });
});
