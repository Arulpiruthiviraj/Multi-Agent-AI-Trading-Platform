import { describe, it, expect } from 'vitest';
import { canonicalPortfolioSymbol, confirmMissingLocally, confirmStillHeldLocally, findHolding } from './portfolioReconcileCompare';
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
