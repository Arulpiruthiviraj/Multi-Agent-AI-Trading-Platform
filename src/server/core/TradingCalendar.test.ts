import { describe, it, expect } from 'vitest';
import { getTradingDateStr, getTradingDayStartMs } from './TradingCalendar';

describe('getTradingDateStr - real America/New_York trading-day boundary', () => {
  it('resolves a UTC instant just after UTC midnight to the PREVIOUS real New York calendar day (the exact bug this phase fixes)', () => {
    // 2026-01-16T02:00:00Z is already "2026-01-16" under naive UTC (`toISOString().split('T')[0]`),
    // but real New York time at that instant is 2026-01-15 21:00 EST - still the prior trading day.
    const utcJustAfterMidnight = new Date('2026-01-16T02:00:00Z');
    expect(getTradingDateStr(utcJustAfterMidnight)).toBe('2026-01-15');
  });

  it('resolves a UTC instant during normal US trading hours to the same calendar day in both zones (sanity check)', () => {
    const midday = new Date('2026-01-15T18:00:00Z'); // 13:00 EST - clearly mid-session, no ambiguity
    expect(getTradingDateStr(midday)).toBe('2026-01-15');
  });

  it('resolves DST (EDT, UTC-4) correctly via the real IANA timezone database, not a fixed offset', () => {
    // 2026-07-15T04:30:00Z during EDT (UTC-4) is 2026-07-15 00:30 New York - the SAME calendar
    // day as the UTC date. A hardcoded UTC-5 offset would wrongly say 2026-07-14.
    const summerInstant = new Date('2026-07-15T04:30:00Z');
    expect(getTradingDateStr(summerInstant)).toBe('2026-07-15');
  });

  it('resolves standard time (EST, UTC-5) correctly via the real IANA timezone database, not a fixed offset', () => {
    // The exact same UTC time-of-day (04:30) in January (EST, UTC-5) is 2026-01-14 23:30 New
    // York - the PREVIOUS calendar day vs UTC. A hardcoded UTC-4 offset would wrongly say
    // 2026-01-15, identical to the summer case above - proving this isn't a fixed-offset hack,
    // since the same UTC time-of-day resolves to a different NY calendar date depending on the
    // real DST rules in effect on that specific date.
    const winterInstant = new Date('2026-01-15T04:30:00Z');
    expect(getTradingDateStr(winterInstant)).toBe('2026-01-14');
  });

  it('defaults to the current instant when called with no argument', () => {
    const result = getTradingDateStr();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

/**
 * Real gap found and fixed (2026-09-15, RiskEngine unbounded-query remediation): RiskEngine's
 * live overtrading-guard query previously fetched the entire `trades` table on every evaluation.
 * getTradingDayStartMs() lets it bound the query to "since the start of the current real trading
 * day" instead - these tests prove the boundary itself is exactly right (DST-aware, matching
 * getTradingDateStr()'s own already-proven boundary, not a second independent calculation that
 * could drift out of sync with it).
 */
describe('getTradingDayStartMs - real trading-day start boundary, EDT/EST', () => {
  it('an instant just before EST midnight (NY) resolves to a start-of-day still within the SAME trading day as itself', () => {
    // 2026-01-15T04:29:00Z = 2026-01-14 23:29 EST - just before New York midnight.
    const instant = new Date('2026-01-15T04:29:00Z');
    const startMs = getTradingDayStartMs(instant);
    expect(getTradingDateStr(new Date(startMs))).toBe(getTradingDateStr(instant));
    expect(startMs).toBeLessThanOrEqual(instant.getTime());
  });

  it('the computed start, and one second earlier, straddle the real EST New York midnight boundary', () => {
    const instant = new Date('2026-01-15T18:00:00Z'); // clearly mid-session EST
    const startMs = getTradingDayStartMs(instant);
    expect(getTradingDateStr(new Date(startMs))).toBe('2026-01-15');
    expect(getTradingDateStr(new Date(startMs - 1000))).toBe('2026-01-14');
  });

  it('resolves the real EDT (summer, UTC-4) midnight boundary correctly, not a fixed EST offset', () => {
    const instant = new Date('2026-07-15T18:00:00Z'); // mid-session EDT
    const startMs = getTradingDayStartMs(instant);
    // Real New York midnight in EDT is 04:00 UTC, not 05:00 UTC (which a hardcoded EST offset
    // would wrongly produce). Binary search is documented as 1-second resolution, so allow up to
    // 1000ms of slack rather than asserting an exact millisecond match.
    expect(Math.abs(startMs - Date.parse('2026-07-15T04:00:00.000Z'))).toBeLessThan(1000);
  });

  it('resolves the real EST (winter, UTC-5) midnight boundary correctly', () => {
    const instant = new Date('2026-01-15T18:00:00Z');
    const startMs = getTradingDayStartMs(instant);
    expect(Math.abs(startMs - Date.parse('2026-01-15T05:00:00.000Z'))).toBeLessThan(1000);
  });

  it('always returns an instant at or before the input, never in the future', () => {
    const instant = new Date('2026-03-08T12:00:00Z'); // a real US DST spring-forward date
    const startMs = getTradingDayStartMs(instant);
    expect(startMs).toBeLessThanOrEqual(instant.getTime());
    expect(getTradingDateStr(new Date(startMs))).toBe(getTradingDateStr(instant));
  });
});
