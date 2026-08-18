import { describe, it, expect } from 'vitest';
import { canonicalPortfolioSymbol, confirmMissingLocally, confirmStillHeldLocally, confirmConsecutiveFault, discrepancyFaultKey, findHolding, positionSetDelta, pruneResolvedFaults, summarizePositionSet } from './portfolioReconcileCompare';
import { tradingSafety } from '../config/tradingSafety';

describe('canonicalPortfolioSymbol', () => {
  it('trims and uppercases so GLD vs gld vs spaced variants compare as one holding', () => {
    expect(canonicalPortfolioSymbol('gld')).toBe('GLD');
    expect(canonicalPortfolioSymbol(' GLD ')).toBe('GLD');
    expect(canonicalPortfolioSymbol('NVDA')).toBe('NVDA');
  });
});

describe('findHolding', () => {
  it('matches a case-variant symbol that exact === would miss', () => {
    const holdings = [{ symbol: 'gld', quantity: 1 }];
    expect(findHolding(holdings, 'GLD')?.quantity).toBe(1);
  });
});

describe('confirmMissingLocally (false MISSING_LOCALLY race)', () => {
  const tol = tradingSafety.reconQtyTolerance;

  it('does not treat a row that landed after the snapshot as missing', async () => {
    const snapshot: { symbol: string; quantity: number }[] = [];
    const fresh = [{ symbol: 'GLD', quantity: 1 }];
    const verdict = await confirmMissingLocally(snapshot, 'GLD', 1, tol, async () => fresh);
    expect(verdict).toBe('present_matching');
  });

  it('still reports missing when the fresh query also has no row', async () => {
    const verdict = await confirmMissingLocally([], 'NVDA', 1, tol, async () => []);
    expect(verdict).toBe('missing');
  });

  it('reports present_drift when fresh local qty disagrees with broker', async () => {
    const verdict = await confirmMissingLocally(
      [{ symbol: 'GLD', quantity: 0 }],
      'GLD',
      1,
      tol,
      async () => [{ symbol: 'GLD', quantity: 0 }],
    );
    expect(verdict).toBe('present_drift');
  });
});

describe('confirmStillHeldLocally (false MISSING_REMOTELY race)', () => {
  const tol = tradingSafety.reconQtyTolerance;

  it('does not treat a row already zeroed on fresh read as still held', async () => {
    const stillHeld = await confirmStillHeldLocally(
      [{ symbol: 'AAPL', quantity: 1 }],
      'AAPL',
      tol,
      async () => [{ symbol: 'AAPL', quantity: 0 }],
    );
    expect(stillHeld).toBe(false);
  });

  it('confirms a genuine local-only holding', async () => {
    const stillHeld = await confirmStillHeldLocally(
      [{ symbol: 'AAPL', quantity: 1 }],
      'AAPL',
      tol,
      async () => [{ symbol: 'AAPL', quantity: 1 }],
    );
    expect(stillHeld).toBe(true);
  });
});

describe('consecutive fault debounce (GLD/NVDA flap)', () => {
  const required = tradingSafety.reconPauseConsecutiveMismatchCycles;

  it('does not confirm a one-off miss', () => {
    const store = new Map<string, number>();
    const key = discrepancyFaultKey('MISSING_LOCALLY', 'gld');
    expect(confirmConsecutiveFault(store, key, required)).toBe(false);
    expect(store.get(key)).toBe(1);
  });

  it('confirms the same discrepancy on the second consecutive cycle', () => {
    const store = new Map<string, number>();
    const key = discrepancyFaultKey('MISSING_LOCALLY', 'NVDA');
    expect(confirmConsecutiveFault(store, key, required)).toBe(false);
    expect(confirmConsecutiveFault(store, key, required)).toBe(true);
  });

  it('resets a symbol that matched on the next cycle', () => {
    const store = new Map<string, number>();
    const gld = discrepancyFaultKey('MISSING_LOCALLY', 'GLD');
    confirmConsecutiveFault(store, gld, required);
    pruneResolvedFaults(store, []);
    expect(store.size).toBe(0);
    expect(confirmConsecutiveFault(store, gld, required)).toBe(false);
  });
});

describe('positionSetDelta', () => {
  const tol = tradingSafety.reconQtyTolerance;

  it('normalizes case and reports only real set differences', () => {
    const remote = summarizePositionSet([{ symbol: 'gld', quantity: 1 }, { symbol: 'NVDA', quantity: 2 }], tol);
    const local = summarizePositionSet([{ symbol: 'GLD', quantity: 1 }, { symbol: 'nvda', quantity: 2 }], tol);
    const delta = positionSetDelta(remote, local, tol);
    expect(delta.missingLocally).toEqual([]);
    expect(delta.missingRemotely).toEqual([]);
    expect(delta.qtyDrift).toEqual([]);
  });
});
