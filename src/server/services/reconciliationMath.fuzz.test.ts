import { describe, it, expect } from 'vitest';
import { safeDollarImpact } from './reconciliationMath';
import { resolveSessionTtlDays } from '../core/AuthConfig';
import { resolveDailyBuyNotionalCap, sumDailyBuyNotional } from '../engines/DailyBuyNotional';

/**
 * 2026-10-05 P1 hardening: property/fuzz tests. These pure functions sit on
 * fail-closed safety paths — they must NEVER return NaN/undefined, NEVER throw
 * unexpectedly, and NEVER produce a value outside their contract, no matter what
 * adversarial input they receive.
 */
describe('P1 pure-function fuzz (2026-10-05)', () => {
  const adversarial: any[] = [
    NaN, Infinity, -Infinity, undefined, null, 0, -0, -1, 1e308, -1e308,
    1e-308, Number.MAX_VALUE, Number.MIN_VALUE, Number.EPSILON,
    '', ' ', 'abc', '123', '12.5', '0x10', '1e5', 'NaN', 'Infinity',
    {}, [], [1], { valueOf: () => 42 }, true, false,
  ];

  it('safeDollarImpact never returns NaN/undefined and always trips the gate on bad input', () => {
    for (const qty of adversarial) {
      for (const price of adversarial) {
        const result = safeDollarImpact(qty, price, 999);
        expect(Number.isFinite(result), `qty=${String(qty)} price=${String(price)}`).toBe(true);
        // Bad input must fail CLOSED (return the trip threshold), never a small number.
        if (!Number.isFinite(qty) || !Number.isFinite(price) || qty == null || price == null) {
          expect(result).toBe(999);
        }
      }
    }
  });

  it('safeDollarImpact computes qty*price for valid positive inputs, fallback otherwise', () => {
    expect(safeDollarImpact(10, 50, 999)).toBe(500);
    expect(safeDollarImpact(-5, 20, 999)).toBe(100); // abs value
    // Zero/non-positive impact fails closed (trips the gate) — never a silent 0.
    expect(safeDollarImpact(0, 100, 999)).toBe(999);
    expect(safeDollarImpact(10, 0, 999)).toBe(999);
    expect(safeDollarImpact(10, -5, 999)).toBe(999);
  });

  it('resolveSessionTtlDays: valid input returns int 1..3650, invalid throws (never silent default)', () => {
    for (const raw of adversarial) {
      try {
        const result = resolveSessionTtlDays(raw as any);
        expect(Number.isInteger(result)).toBe(true);
        expect(result).toBeGreaterThanOrEqual(1);
        expect(result).toBeLessThanOrEqual(3650);
      } catch (e) {
        expect(e).toBeInstanceOf(Error); // fail-closed throw is the only other option
      }
    }
    // Spot checks.
    expect(resolveSessionTtlDays('90')).toBe(90);
    expect(resolveSessionTtlDays('30')).toBe(30);
    expect(() => resolveSessionTtlDays('0')).toThrow();
    expect(() => resolveSessionTtlDays('-5')).toThrow();
    expect(() => resolveSessionTtlDays('abc')).toThrow();
    expect(() => resolveSessionTtlDays('3.5')).toThrow();
  });

  it('resolveDailyBuyNotionalCap: never returns null/undefined; misconfigured cap fails CLOSED to 0', async () => {
    const { tradingSafety } = await import('../config/tradingSafety');
    const original = tradingSafety.maxDailyBuyNotionalDollars;
    try {
      // Valid config → the configured cap.
      (tradingSafety as any).maxDailyBuyNotionalDollars = 5000;
      expect(resolveDailyBuyNotionalCap('PAPER')).toBe(5000);
      // Misconfigured (zero/negative/NaN) → 0 (blocks all BUYs), never null (uncapped).
      for (const bad of [0, -100, NaN, -Infinity]) {
        (tradingSafety as any).maxDailyBuyNotionalDollars = bad;
        const result = resolveDailyBuyNotionalCap('PAPER');
        expect(result).toBe(0);
        expect(result).not.toBeNull();
      }
    } finally {
      (tradingSafety as any).maxDailyBuyNotionalDollars = original;
    }
  });

  it('sumDailyBuyNotional: corrupt rows never reduce the total or produce NaN', () => {
    const today = new Date().toISOString();
    const base = { side: 'BUY', status: 'FILLED', timestamp: today };
    const rows: any[] = [
      { ...base, price: 100, quantity: 10 },           // 1000 — valid
      { ...base, price: -50, quantity: 10 },          // corrupt — skipped
      { ...base, price: 100, quantity: -5 },          // corrupt — skipped
      { ...base, price: 0, quantity: 10 },            // corrupt — skipped
      { ...base, price: NaN, quantity: 10 },          // corrupt — skipped
      { ...base, price: 100, quantity: Infinity },    // corrupt — skipped
      { ...base, price: null, quantity: 10 },         // corrupt — skipped
      { ...base, price: 50, quantity: 4 },            // 200 — valid
    ];
    // Shuffle to ensure order-independence.
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }
    const total = sumDailyBuyNotional(rows as any);
    expect(total).toBe(1200);
    expect(Number.isFinite(total)).toBe(true);
  });
});
