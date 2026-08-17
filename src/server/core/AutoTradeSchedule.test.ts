import { describe, it, expect } from 'vitest';
import { isValidHHMM, isValidTimezone, isWithinScheduledWindow } from './AutoTradeSchedule';

describe('isValidHHMM', () => {
  it('accepts real zero-padded 24h times', () => {
    expect(isValidHHMM('00:00')).toBe(true);
    expect(isValidHHMM('09:30')).toBe(true);
    expect(isValidHHMM('23:59')).toBe(true);
  });

  it('rejects malformed or out-of-range values', () => {
    expect(isValidHHMM('24:00')).toBe(false);
    expect(isValidHHMM('9:30')).toBe(false); // not zero-padded
    expect(isValidHHMM('09:60')).toBe(false);
    expect(isValidHHMM('')).toBe(false);
    expect(isValidHHMM(undefined)).toBe(false);
    expect(isValidHHMM(930)).toBe(false);
  });
});

describe('isValidTimezone', () => {
  it('accepts real IANA zones via the ICU database, not a hardcoded list', () => {
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('America/Toronto')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Asia/Tokyo')).toBe(true);
  });

  it('rejects garbage and non-string input', () => {
    expect(isValidTimezone('Not/A/Zone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone(null)).toBe(false);
    expect(isValidTimezone(42)).toBe(false);
  });
});

describe('isWithinScheduledWindow', () => {
  it('is true at and after start, false at and after end (half-open interval)', () => {
    expect(isWithinScheduledWindow('09:30', '09:30', '16:00')).toBe(true);
    expect(isWithinScheduledWindow('15:59', '09:30', '16:00')).toBe(true);
    expect(isWithinScheduledWindow('16:00', '09:30', '16:00')).toBe(false);
    expect(isWithinScheduledWindow('09:29', '09:30', '16:00')).toBe(false);
  });

  it('fails closed on a misconfigured start >= end rather than guessing a wraparound', () => {
    expect(isWithinScheduledWindow('23:00', '22:00', '06:00')).toBe(false);
    expect(isWithinScheduledWindow('12:00', '12:00', '12:00')).toBe(false);
  });

  it('fails closed on any invalid HH:MM input', () => {
    expect(isWithinScheduledWindow('bad', '09:30', '16:00')).toBe(false);
    expect(isWithinScheduledWindow('10:00', 'bad', '16:00')).toBe(false);
    expect(isWithinScheduledWindow('10:00', '09:30', 'bad')).toBe(false);
  });
});
