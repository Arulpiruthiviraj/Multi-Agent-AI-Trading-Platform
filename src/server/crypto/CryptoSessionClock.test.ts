import { describe, it, expect } from 'vitest';
import {
  getCryptoTradingDateStr,
  getCryptoSessionSnapshot,
  isCryptoTradingDayRollover,
  getCryptoTradingDayStartMs,
} from './CryptoSessionClock';

describe('CryptoSessionClock', () => {
  it('derives the UTC calendar day, not the local machine timezone', () => {
    // 2026-09-21T23:30:00Z is still 2026-09-21 in UTC even though it would already be the next
    // calendar day in most timezones east of UTC - proves this never reads local machine time.
    const late = new Date('2026-09-21T23:30:00.000Z');
    expect(getCryptoTradingDateStr(late)).toBe('2026-09-21');
  });

  it('rolls the trading day over exactly at UTC midnight, not before or after', () => {
    const justBefore = new Date('2026-09-21T23:59:59.999Z');
    const justAfter = new Date('2026-09-22T00:00:00.000Z');
    expect(getCryptoTradingDateStr(justBefore)).toBe('2026-09-21');
    expect(getCryptoTradingDateStr(justAfter)).toBe('2026-09-22');
  });

  it('reports isContinuous true - crypto never closes, unlike equity PREMARKET/REGULAR/CLOSED', () => {
    const snapshot = getCryptoSessionSnapshot(new Date('2026-09-21T14:00:00.000Z'));
    expect(snapshot.isContinuous).toBe(true);
  });

  it('computes seconds since/until UTC midnight consistently (they sum to one day)', () => {
    const now = new Date('2026-09-21T06:15:30.000Z');
    const snapshot = getCryptoSessionSnapshot(now);
    expect(snapshot.secondsSinceUtcMidnight).toBe(6 * 3600 + 15 * 60 + 30);
    expect(snapshot.secondsSinceUtcMidnight + snapshot.secondsUntilNextUtcMidnight).toBe(24 * 3600);
  });

  it('detects a real day rollover between two instants on different UTC calendar days', () => {
    const a = new Date('2026-09-21T23:59:00.000Z');
    const b = new Date('2026-09-22T00:01:00.000Z');
    expect(isCryptoTradingDayRollover(a, b)).toBe(true);
  });

  it('does not report a rollover for two instants on the same UTC calendar day', () => {
    const a = new Date('2026-09-21T01:00:00.000Z');
    const b = new Date('2026-09-21T23:00:00.000Z');
    expect(isCryptoTradingDayRollover(a, b)).toBe(false);
  });

  it('defaults to the real current time when no argument is supplied', () => {
    const before = Date.now();
    const snapshot = getCryptoSessionSnapshot();
    const after = Date.now();
    expect(snapshot.nowUtc.getTime()).toBeGreaterThanOrEqual(before);
    expect(snapshot.nowUtc.getTime()).toBeLessThanOrEqual(after);
  });

  // Crypto Expansion Phase 3 (2026-09-21)
  describe('getCryptoTradingDayStartMs', () => {
    it('returns real UTC midnight for the given instant', () => {
      const ms = getCryptoTradingDayStartMs(new Date('2026-09-21T15:30:00.000Z'));
      expect(new Date(ms).toISOString()).toBe('2026-09-21T00:00:00.000Z');
    });

    it('is always at or before its own getCryptoTradingDateStr instant, and before the equivalent America/New_York day-start', () => {
      const now = new Date('2026-09-21T12:00:00.000Z');
      const cryptoStart = getCryptoTradingDayStartMs(now);
      expect(cryptoStart).toBeLessThanOrEqual(now.getTime());
      // 2026-09-21 is DST (EDT, UTC-4) - NY midnight is 2026-09-21T04:00:00Z, strictly after UTC midnight.
      expect(cryptoStart).toBeLessThan(new Date('2026-09-21T04:00:00.000Z').getTime());
    });
  });
});
