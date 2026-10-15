import { describe, it, expect } from 'vitest';
import { runExitOracle, type OracleBar, type OracleFill } from './exitOracle';

const MIN = 60_000;
const bars = (closes: number[]): OracleBar[] => closes.map((close, i) => ({ atMs: i * MIN, close }));
const base = { stopPct: 5, graceMs: 12 * MIN, sessionEndMs: 100 * MIN };

describe('exitOracle', () => {
  const buy: OracleFill = { atMs: 0, symbol: 'AAA', side: 'BUY', quantity: 10, price: 100 };

  it('flags a position that stays open more than the grace window after a bar closes through the stop', () => {
    const closes = [100, 99, 94, 93, 93, 93, 93, 93, 93, 93, 93, 93, 93, 93, 93, 93];
    const r = runExitOracle({ ...base, fills: [buy], barsBySymbol: new Map([['AAA', bars(closes)]]) });
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({ code: 'PROTECTIVE_EXIT_MISSING', symbol: 'AAA', breachAtMs: 2 * MIN, positionQty: 10 });
  });

  it('passes when a SELL fill closes the position inside the grace window', () => {
    const closes = [100, 99, 94, 93, 93, 93, 93, 93, 93, 93, 93, 93, 93, 93, 93, 93];
    const sell: OracleFill = { atMs: 6 * MIN, symbol: 'AAA', side: 'SELL', quantity: 10, price: 93 };
    const r = runExitOracle({ ...base, fills: [buy, sell], barsBySymbol: new Map([['AAA', bars(closes)]]) });
    expect(r.violations).toEqual([]);
    expect(r.breaches).toBe(1);
  });

  it('does not flag a dip that recovers before the grace window ends, or a loss smaller than the stop', () => {
    const r = runExitOracle({ ...base, fills: [buy], barsBySymbol: new Map([['AAA', bars([100, 96, 95.5, 99, 100, 101, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100])]]) });
    expect(r.violations).toEqual([]);
  });

  it('a SELL that only partly closes the position leaves the remainder under the oracle', () => {
    const closes = [100, 94, 93, 93, 93, 93, 93, 93, 93, 93, 93, 93, 93, 93, 93, 93];
    const partial: OracleFill = { atMs: 3 * MIN, symbol: 'AAA', side: 'SELL', quantity: 4, price: 93 };
    const r = runExitOracle({ ...base, fills: [buy, partial], barsBySymbol: new Map([['AAA', bars(closes)]]) });
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].positionQty).toBe(6);
  });

  it('ignores symbols that were never held', () => {
    const r = runExitOracle({ ...base, fills: [], barsBySymbol: new Map([['AAA', bars([100, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50])]]) });
    expect(r).toMatchObject({ checkedPositions: 0, violations: [] });
  });
});
