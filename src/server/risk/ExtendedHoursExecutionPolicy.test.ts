import { describe, it, expect } from 'vitest';
import { evaluateExtendedHoursExecutionPolicy, resolveOrderConstruction, isExtendedHoursSession } from './ExtendedHoursExecutionPolicy';
import type { BrokerCapabilities } from '../../brokers/BrokerAdapter';

const capableCaps: BrokerCapabilities = {
  canPlaceOrders: true, canCancelOrders: true, paperTrading: true, liveTrading: false,
  usEquities: true, canadianEquities: false, crypto: false, options: false,
  shortSelling: false, streamingMarketData: false, requiresManualReauth: false,
  extendedHoursOrders: true,
};
const incapableCaps: BrokerCapabilities = { ...capableCaps, extendedHoursOrders: false };

describe('isExtendedHoursSession', () => {
  it('true for PRE_MARKET and AFTER_HOURS, false for REGULAR and CLOSED', () => {
    expect(isExtendedHoursSession('PRE_MARKET')).toBe(true);
    expect(isExtendedHoursSession('AFTER_HOURS')).toBe(true);
    expect(isExtendedHoursSession('REGULAR')).toBe(false);
    expect(isExtendedHoursSession('CLOSED')).toBe(false);
  });
});

describe('evaluateExtendedHoursExecutionPolicy', () => {
  const goodInput = {
    session: 'PRE_MARKET' as const,
    extendedHoursExecutionEnabled: true,
    brokerCapabilities: capableCaps,
    quoteAgeMs: 60_000,
    spreadBps: 20,
    avgDailyVolumeShares: 1_000_000,
    notionalDollars: 500,
  };

  it('auto-passes (skipped) for a REGULAR session regardless of every other input - zero behavior change for the common case', () => {
    const result = evaluateExtendedHoursExecutionPolicy({ ...goodInput, session: 'REGULAR', brokerCapabilities: incapableCaps, spreadBps: 9999 });
    expect(result.passed).toBe(true);
    expect(result.detail.skipped).toBe(true);
  });

  it('auto-passes (skipped) when extended-hours execution is disabled, even in PRE_MARKET with bad inputs', () => {
    const result = evaluateExtendedHoursExecutionPolicy({ ...goodInput, extendedHoursExecutionEnabled: false, brokerCapabilities: incapableCaps });
    expect(result.passed).toBe(true);
    expect(result.detail.skipped).toBe(true);
  });

  it('passes when every real check clears', () => {
    const result = evaluateExtendedHoursExecutionPolicy(goodInput);
    expect(result.passed).toBe(true);
    expect(result.detail.skipped).toBe(false);
  });

  it('fails when the broker cannot construct an extended-hours order', () => {
    const result = evaluateExtendedHoursExecutionPolicy({ ...goodInput, brokerCapabilities: incapableCaps });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/BROKER_UNSUPPORTED/);
  });

  it('fails when brokerCapabilities is null', () => {
    const result = evaluateExtendedHoursExecutionPolicy({ ...goodInput, brokerCapabilities: null });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/BROKER_UNSUPPORTED/);
  });

  it('fails on a stale quote (age exceeds extendedHoursMaxQuoteAgeMs)', () => {
    const result = evaluateExtendedHoursExecutionPolicy({ ...goodInput, quoteAgeMs: 10_000_000 });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/STALE_QUOTE/);
  });

  it('fails when there has never been a quote at all (quoteAgeMs null)', () => {
    const result = evaluateExtendedHoursExecutionPolicy({ ...goodInput, quoteAgeMs: null });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/STALE_QUOTE/);
  });

  it('fails on a spread wider than extendedHoursMaxSpreadBps', () => {
    const result = evaluateExtendedHoursExecutionPolicy({ ...goodInput, spreadBps: 500 });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/SPREAD_TOO_WIDE/);
  });

  it('fails closed when no real spread data exists at all (never assumes a tight spread)', () => {
    const result = evaluateExtendedHoursExecutionPolicy({ ...goodInput, spreadBps: null });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/NO_SPREAD_DATA/);
  });

  it('fails closed when no real ADV data has been cached for this symbol yet (never assumes sufficient liquidity)', () => {
    const result = evaluateExtendedHoursExecutionPolicy({ ...goodInput, avgDailyVolumeShares: null });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/NO_LIQUIDITY_DATA/);
  });

  it('fails when real ADV is below extendedHoursMinAvgDailyVolumeShares', () => {
    const result = evaluateExtendedHoursExecutionPolicy({ ...goodInput, avgDailyVolumeShares: 1000 });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/INSUFFICIENT_LIQUIDITY/);
  });

  it('fails when requested notional exceeds the extended-hours cap, even though it might clear the regular order_notional_cap', () => {
    const result = evaluateExtendedHoursExecutionPolicy({ ...goodInput, notionalDollars: 2900 }); // under maxTradeSize $3000, over extendedHoursMaxNotionalDollars $1000
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/NOTIONAL_CAP/);
  });

  it('checks are evaluated in a defined order - broker capability before quote/spread/notional', () => {
    const result = evaluateExtendedHoursExecutionPolicy({ ...goodInput, brokerCapabilities: incapableCaps, quoteAgeMs: null, spreadBps: null, notionalDollars: 999999 });
    expect(result.reason).toMatch(/BROKER_UNSUPPORTED/); // not STALE_QUOTE, SPREAD, or NOTIONAL
  });
});

describe('resolveOrderConstruction', () => {
  it('always MARKET when the flag is disabled, regardless of session/price - the default, zero-cost path', () => {
    expect(resolveOrderConstruction('PRE_MARKET', 150.25, false)).toEqual({ type: 'MARKET' });
  });

  it('always MARKET for a REGULAR session, even when the flag is enabled', () => {
    expect(resolveOrderConstruction('REGULAR', 150.25, true)).toEqual({ type: 'MARKET' });
  });

  it('resolves to LIMIT+extendedHours for PRE_MARKET with a valid price and the flag enabled', () => {
    expect(resolveOrderConstruction('PRE_MARKET', 150.25, true)).toEqual({ type: 'LIMIT', price: 150.25, extendedHours: true });
  });

  it('resolves to LIMIT+extendedHours for AFTER_HOURS with a valid price and the flag enabled', () => {
    expect(resolveOrderConstruction('AFTER_HOURS', 99.5, true)).toEqual({ type: 'LIMIT', price: 99.5, extendedHours: true });
  });

  it('falls back to MARKET rather than fabricating a limit price when no valid price is available', () => {
    expect(resolveOrderConstruction('PRE_MARKET', null, true)).toEqual({ type: 'MARKET' });
    expect(resolveOrderConstruction('PRE_MARKET', undefined, true)).toEqual({ type: 'MARKET' });
    expect(resolveOrderConstruction('PRE_MARKET', 0, true)).toEqual({ type: 'MARKET' });
    expect(resolveOrderConstruction('PRE_MARKET', -5, true)).toEqual({ type: 'MARKET' });
    expect(resolveOrderConstruction('PRE_MARKET', NaN, true)).toEqual({ type: 'MARKET' });
  });

  it('CLOSED session always resolves to MARKET (gate 12 would reject it anyway; this is not the enforcement point)', () => {
    expect(resolveOrderConstruction('CLOSED', 150.25, true)).toEqual({ type: 'MARKET' });
  });
});
