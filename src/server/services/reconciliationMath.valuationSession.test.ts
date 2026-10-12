import { describe, it, expect } from 'vitest';
import { valuationMarksExpectedUnavailable } from './reconciliationMath';

const et = (iso: string) => Date.parse(iso); // ISO with explicit UTC offset
describe('valuationMarksExpectedUnavailable (2026-10-12 overnight false pause)', () => {
  it('is expected while the market session is CLOSED (overnight, weekend)', () => {
    expect(valuationMarksExpectedUnavailable(et('2026-10-12T21:30:00-04:00'))).toBe(true); // Mon 21:30 ET
    expect(valuationMarksExpectedUnavailable(et('2026-10-13T02:00:00-04:00'))).toBe(true); // Tue 02:00 ET
    expect(valuationMarksExpectedUnavailable(et('2026-10-17T12:00:00-04:00'))).toBe(true); // Sat
  });
  it('is NOT exempt when marks should exist: pre-market, regular session, after-hours', () => {
    expect(valuationMarksExpectedUnavailable(et('2026-10-13T08:00:00-04:00'))).toBe(false);
    expect(valuationMarksExpectedUnavailable(et('2026-10-13T11:00:00-04:00'))).toBe(false);
    expect(valuationMarksExpectedUnavailable(et('2026-10-13T17:00:00-04:00'))).toBe(false);
  });
});
