import { describe, it, expect } from 'vitest';
import { resolveIbkrWebOrderType } from './InteractiveBrokersWebApiAdapter';

// P1-4 (2026-10-04): placeOrder() used to map anything other than LIMIT to 'MKT' - a STOP or
// STOP_LIMIT order (a protective exit) would silently submit as an unprotected MARKET order. This
// table covers every member of the real Order type union (BrokerAdapter.ts) so no future addition
// to that union can silently fall through to a MARKET downgrade again.
describe('resolveIbkrWebOrderType (IBKR Client Portal order-type fidelity)', () => {
  it('maps MARKET to MKT with no price/auxPrice', () => {
    expect(resolveIbkrWebOrderType({ type: 'MARKET' })).toEqual({ orderType: 'MKT', price: undefined, auxPrice: undefined });
  });

  it('maps LIMIT to LMT, carrying price, never auxPrice', () => {
    expect(resolveIbkrWebOrderType({ type: 'LIMIT', price: 150.25 })).toEqual({ orderType: 'LMT', price: 150.25, auxPrice: undefined });
  });

  it('maps STOP to STP, carrying auxPrice (the trigger), never price', () => {
    expect(resolveIbkrWebOrderType({ type: 'STOP', stopPrice: 140 })).toEqual({ orderType: 'STP', price: undefined, auxPrice: 140 });
  });

  it('maps STOP_LIMIT to STOP_LIMIT, carrying both price and auxPrice', () => {
    expect(resolveIbkrWebOrderType({ type: 'STOP_LIMIT', price: 139.5, stopPrice: 140 })).toEqual({ orderType: 'STOP_LIMIT', price: 139.5, auxPrice: 140 });
  });

  it('defaults a missing type to MARKET (same default placeOrder already applies)', () => {
    expect(resolveIbkrWebOrderType({} as any)).toEqual({ orderType: 'MKT', price: undefined, auxPrice: undefined });
  });

  it.each(['STOP', 'STOP_LIMIT'] as const)('refuses %s with no valid stopPrice rather than submitting an unprotected order', (type) => {
    expect(() => resolveIbkrWebOrderType({ type, stopPrice: undefined })).toThrow('UNSUPPORTED_ORDER_TYPE');
    expect(() => resolveIbkrWebOrderType({ type, stopPrice: 0 })).toThrow('UNSUPPORTED_ORDER_TYPE');
    expect(() => resolveIbkrWebOrderType({ type, stopPrice: NaN })).toThrow('UNSUPPORTED_ORDER_TYPE');
    expect(() => resolveIbkrWebOrderType({ type, stopPrice: -5 })).toThrow('UNSUPPORTED_ORDER_TYPE');
  });

  // Every remaining member of the real Order.type union this adapter does not implement - each
  // must throw UNSUPPORTED_ORDER_TYPE, never silently fall back to MARKET.
  it.each(['TRAILING_STOP', 'BRACKET', 'OCO', 'ICEBERG', 'TWAP', 'VWAP'] as const)(
    'refuses unsupported type %s rather than downgrading to MARKET',
    (type) => {
      expect(() => resolveIbkrWebOrderType({ type })).toThrow('UNSUPPORTED_ORDER_TYPE');
    },
  );

  it('refuses a completely unknown/garbage type string rather than defaulting to MARKET', () => {
    expect(() => resolveIbkrWebOrderType({ type: 'NOT_A_REAL_TYPE' as any })).toThrow('UNSUPPORTED_ORDER_TYPE');
  });
});
