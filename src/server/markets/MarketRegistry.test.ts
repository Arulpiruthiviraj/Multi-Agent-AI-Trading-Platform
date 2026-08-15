import { describe, it, expect } from 'vitest';
import { resolveListing, isCanadianListing, listingCurrency, canadianAutomatedRoutingStatus } from './MarketRegistry';

describe('MarketRegistry', () => {
  it('resolves TSX suffix .TO as CAD / TSX without treating it as USD', () => {
    const listing = resolveListing('SHOP.TO');
    expect(listing.exchange).toBe('TSX');
    expect(listing.market).toBe('CA');
    expect(listing.currency).toBe('CAD');
    expect(isCanadianListing('SHOP.TO')).toBe(true);
    expect(listingCurrency('shop.to')).toBe('CAD');
  });

  it('resolves TSXV suffix .V', () => {
    const listing = resolveListing('TEST.V');
    expect(listing.exchange).toBe('TSXV');
    expect(listing.currency).toBe('CAD');
  });

  it('defaults a bare US ticker to USD and does not mark it Canadian', () => {
    const listing = resolveListing('AAPL');
    expect(listing.market).toBe('US');
    expect(listing.currency).toBe('USD');
    expect(isCanadianListing('AAPL')).toBe(false);
  });

  it('does not claim automated Canadian order routing is available', () => {
    expect(canadianAutomatedRoutingStatus()).toMatch(/BLOCKED/);
  });
});
