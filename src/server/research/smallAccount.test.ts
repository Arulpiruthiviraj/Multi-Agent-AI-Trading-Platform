import { describe, it, expect } from 'vitest';
import { sizeSmallAccount } from './smallAccount';

describe('SMALL_ACCOUNT_RESEARCH_MODE', () => {
  it('does not treat a $100 account as able to buy a $101 name in whole shares', () => {
    const r = sizeSmallAccount(100, 101);
    expect(r.executable).toBe(false);
    expect(r.reason).toBe('INSUFFICIENT_CASH_FOR_MIN_LOT');
  });

  it('sizes whole shares at $100 when price is $20', () => {
    const r = sizeSmallAccount(100, 20);
    expect(r.wholeShares).toBe(5);
    expect(r.executable).toBe(true);
  });
});
