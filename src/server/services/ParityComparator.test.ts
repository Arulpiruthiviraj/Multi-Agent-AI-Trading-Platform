import { describe, it, expect } from 'vitest';
import { compareSnapshots } from './ParityComparator';

describe('compareSnapshots', () => {
  it('reports no divergence when TS and Java agree', () => {
    const snap = { rsi: 60, macd: 1.2, macdSignal: 0.9, bbUpper: 110, bbLower: 90 };
    expect(compareSnapshots(snap, snap)).toEqual([]);
  });

  it('flags a field that diverges beyond the threshold', () => {
    const ts = { rsi: 60, macd: 1.2, macdSignal: 0.9, bbUpper: 110, bbLower: 90 };
    const java = { rsi: 65, macd: 1.2, macdSignal: 0.9, bbUpper: 110, bbLower: 90 }; // rsi off by ~8.3%
    const divergences = compareSnapshots(ts, java, 0.0001);
    expect(divergences).toHaveLength(1);
    expect(divergences[0].field).toBe('rsi');
    expect(divergences[0].diffPct).toBeCloseTo((65 - 60) / 60, 5);
  });

  it('does not flag a field within the threshold', () => {
    const ts = { rsi: 60, macd: null, macdSignal: null, bbUpper: null, bbLower: null };
    const java = { rsi: 60.001, macd: null, macdSignal: null, bbUpper: null, bbLower: null };
    expect(compareSnapshots(ts, java, 0.01)).toEqual([]);
  });

  it('skips a field that is null on either side rather than fabricating a divergence', () => {
    const ts = { rsi: null, macd: 1, macdSignal: 1, bbUpper: null, bbLower: null };
    const java = { rsi: 99, macd: 1, macdSignal: 1, bbUpper: 5, bbLower: 5 };
    expect(compareSnapshots(ts, java, 0.0001)).toEqual([]);
  });

  it('skips a field where the TS value is exactly 0 (division-by-zero guard)', () => {
    const ts = { rsi: 0, macd: null, macdSignal: null, bbUpper: null, bbLower: null };
    const java = { rsi: 50, macd: null, macdSignal: null, bbUpper: null, bbLower: null };
    expect(compareSnapshots(ts, java, 0.0001)).toEqual([]);
  });

  it('flags multiple diverging fields independently', () => {
    const ts = { rsi: 60, macd: 1, macdSignal: 1, bbUpper: 100, bbLower: 100 };
    const java = { rsi: 90, macd: 1, macdSignal: 2, bbUpper: 100, bbLower: 100 };
    const divergences = compareSnapshots(ts, java, 0.0001);
    expect(divergences.map((d) => d.field).sort()).toEqual(['macdSignal', 'rsi']);
  });
});
