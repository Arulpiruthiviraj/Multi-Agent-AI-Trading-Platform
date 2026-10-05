import { describe, it, expect } from 'vitest';
import { evaluateDailyBuyNotional, resolveDailyBuyNotionalCap, sumDailyBuyNotional } from './DailyBuyNotional';
import { tradingSafety } from '../config/tradingSafety';

describe('DailyBuyNotional', () => {
  it('caps paper at maxDailyBuyNotionalDollars from reviewed JSON', () => {
    expect(tradingSafety.maxDailyBuyNotionalDollars).toBeGreaterThan(0);
    expect(resolveDailyBuyNotionalCap('PAPER')).toBe(tradingSafety.maxDailyBuyNotionalDollars);
  });

  it('always applies the restricted-live file ceiling in LIVE', () => {
    expect(resolveDailyBuyNotionalCap('LIVE')).toBe(tradingSafety.restrictedLiveMaxDailyBuyNotionalDollars);
  });

  it('sums only today NY-dated countable BUY rows', () => {
    const sum = sumDailyBuyNotional([
      { side: 'BUY', status: 'FILLED', price: 10, quantity: 2, timestamp: '2026-08-15T18:00:00.000Z' },
      { side: 'SELL', status: 'FILLED', price: 10, quantity: 9, timestamp: '2026-08-15T18:00:00.000Z' },
      { side: 'BUY', status: 'REJECTED', price: 10, quantity: 9, timestamp: '2026-08-15T18:00:00.000Z' },
    ], '2026-08-15');
    expect(sum).toBe(20);
  });

  it('rejects when projected BUY notional exceeds the cap', () => {
    const r = evaluateDailyBuyNotional({ cap: 100, side: 'BUY', alreadyDeployed: 80, requestedNotional: 30 });
    expect(r.passed).toBe(false);
    expect(r.projected).toBe(110);
  });

  it('skips SELLs and a null cap', () => {
    expect(evaluateDailyBuyNotional({ cap: 100, side: 'SELL', alreadyDeployed: 999, requestedNotional: 1 }).passed).toBe(true);
    expect(evaluateDailyBuyNotional({ cap: null, side: 'BUY', alreadyDeployed: 999, requestedNotional: 1 }).skipped).toBe(true);
  });
});

describe('DailyBuyNotional P1 fail-closed (2026-10-05)', () => {
  it('fails CLOSED to $0 (not null/uncapped) on a non-positive configured cap', () => {
    const orig = tradingSafety.maxDailyBuyNotionalDollars;
    try {
      (tradingSafety as any).maxDailyBuyNotionalDollars = 0;
      expect(resolveDailyBuyNotionalCap('PAPER')).toBe(0);
      (tradingSafety as any).maxDailyBuyNotionalDollars = -500;
      expect(resolveDailyBuyNotionalCap('PAPER')).toBe(0);
      // A $0 cap blocks every BUY: projected > 0 can never be <= 0.
      const r = evaluateDailyBuyNotional({ cap: 0, side: 'BUY', alreadyDeployed: 0, requestedNotional: 1 });
      expect(r.passed).toBe(false);
      expect(r.skipped).toBe(false);
    } finally {
      (tradingSafety as any).maxDailyBuyNotionalDollars = orig;
    }
  });

  it('skips non-positive price/quantity rows instead of letting them reduce deployed notional', () => {
    const sum = sumDailyBuyNotional([
      { side: 'BUY', status: 'FILLED', price: 10, quantity: 2, timestamp: '2026-08-15T18:00:00.000Z' },
      { side: 'BUY', status: 'FILLED', price: -10, quantity: 2, timestamp: '2026-08-15T18:00:00.000Z' },
      { side: 'BUY', status: 'FILLED', price: 10, quantity: -2, timestamp: '2026-08-15T18:00:00.000Z' },
      { side: 'BUY', status: 'FILLED', price: 0, quantity: 5, timestamp: '2026-08-15T18:00:00.000Z' },
    ], '2026-08-15');
    expect(sum).toBe(20);
  });
});
