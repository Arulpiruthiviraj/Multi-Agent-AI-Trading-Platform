import { describe, it, expect } from 'vitest';
import { applyRestrictedLiveCaps, isRestrictedLiveModeActive, RESTRICTED_LIVE_MAX_ORDER_NOTIONAL_DOLLARS, RESTRICTED_LIVE_MAX_OPEN_POSITIONS, RESTRICTED_LIVE_MAX_DAILY_LOSS_DOLLARS } from './RestrictedLiveMode';

describe('applyRestrictedLiveCaps (Phase 13)', () => {
  it('is a real no-op (identity) for paper trading - no behavior change for the vast majority of real usage', () => {
    const result = applyRestrictedLiveCaps({
      tradingMode: 'PAPER', maxTradeSizeDollar: 1_000_000, maxOpenPositions: 999, dailyLossLimitDollars: 500_000,
    });
    expect(result).toEqual({ maxTradeSizeDollar: 1_000_000, maxOpenPositions: 999, dailyLossLimitDollars: 500_000, restricted: false });
  });

  it('is a real no-op for an undefined/null tradingMode (defensive default)', () => {
    const result = applyRestrictedLiveCaps({ tradingMode: undefined, maxTradeSizeDollar: 50, maxOpenPositions: 1, dailyLossLimitDollars: 10 });
    expect(result.restricted).toBe(false);
  });

  it('clamps a permissive settings-derived value DOWN to the hardcoded ceiling when real live trading is active', () => {
    const result = applyRestrictedLiveCaps({
      tradingMode: 'LIVE', maxTradeSizeDollar: 1_000_000, maxOpenPositions: 999, dailyLossLimitDollars: 500_000,
    });
    expect(result.restricted).toBe(true);
    expect(result.maxTradeSizeDollar).toBe(RESTRICTED_LIVE_MAX_ORDER_NOTIONAL_DOLLARS);
    expect(result.maxOpenPositions).toBe(RESTRICTED_LIVE_MAX_OPEN_POSITIONS);
    expect(result.dailyLossLimitDollars).toBe(RESTRICTED_LIVE_MAX_DAILY_LOSS_DOLLARS);
  });

  it('never LOOSENS an already-tighter settings value in live mode - only ever the minimum of the two', () => {
    const result = applyRestrictedLiveCaps({
      tradingMode: 'LIVE', maxTradeSizeDollar: 100, maxOpenPositions: 1, dailyLossLimitDollars: 50,
    });
    expect(result.maxTradeSizeDollar).toBe(100); // tighter than the hardcoded 5000 ceiling - kept as-is
    expect(result.maxOpenPositions).toBe(1);
    expect(result.dailyLossLimitDollars).toBe(50);
  });
});

describe('isRestrictedLiveModeActive', () => {
  it('is true only for the exact string "LIVE"', () => {
    expect(isRestrictedLiveModeActive('LIVE')).toBe(true);
    expect(isRestrictedLiveModeActive('PAPER')).toBe(false);
    expect(isRestrictedLiveModeActive(undefined)).toBe(false);
    expect(isRestrictedLiveModeActive(null)).toBe(false);
    expect(isRestrictedLiveModeActive('')).toBe(false);
  });
});
