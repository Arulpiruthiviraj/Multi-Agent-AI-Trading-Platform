/**
 * 2026-10-04 (opening-range session-anchoring fix): regularSessionOpenMs() must return the
 * real regular-session open (replaySafety.regularSessionStartMinutes = 570 = 9:30 AM) in the
 * given timezone, DST-correct - no hardcoded EST/EDT offset.
 */
import { describe, it, expect } from 'vitest';
import { regularSessionOpenMs } from './marketSession';

describe('regularSessionOpenMs', () => {
  it('returns 9:30 AM ET on an EDT date (October - UTC-4)', () => {
    // Monday 2026-10-05, midday UTC.
    const open = regularSessionOpenMs(Date.parse('2026-10-05T12:00:00Z'), 'America/New_York');
    expect(open).toBe(Date.parse('2026-10-05T13:30:00Z'));
  });

  it('returns 9:30 AM ET on an EST date (January - UTC-5)', () => {
    // Monday 2026-01-05, midday UTC.
    const open = regularSessionOpenMs(Date.parse('2026-01-05T12:00:00Z'), 'America/New_York');
    expect(open).toBe(Date.parse('2026-01-05T14:30:00Z'));
  });

  it('resolves to the same wall-clock time across the DST boundary', () => {
    // Sunday 2026-11-01 is EDT; the fall-back happens that morning at 2:00 AM.
    // Monday 2026-11-02 is EST. Both opens must read 09:30 in New York.
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const before = regularSessionOpenMs(Date.parse('2026-10-30T12:00:00Z'), 'America/New_York');
    const after = regularSessionOpenMs(Date.parse('2026-11-02T12:00:00Z'), 'America/New_York');
    expect(fmt.format(new Date(before))).toBe('09:30');
    expect(fmt.format(new Date(after))).toBe('09:30');
    // And they are exactly one hour apart in UTC terms across the transition week boundary check:
    // Oct 30 open = 13:30 UTC, Nov 2 open = 14:30 UTC.
    expect(before).toBe(Date.parse('2026-10-30T13:30:00Z'));
    expect(after).toBe(Date.parse('2026-11-02T14:30:00Z'));
  });
});
