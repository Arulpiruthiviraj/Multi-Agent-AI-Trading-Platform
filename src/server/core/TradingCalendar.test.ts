import { describe, it, expect } from 'vitest';
import { getTradingDateStr } from './TradingCalendar';

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
