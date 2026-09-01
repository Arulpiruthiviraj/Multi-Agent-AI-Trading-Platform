import { describe, it, expect } from 'vitest';
import { computeReplayFillClockMs } from './FullArgusReplayEngine';
import { classifyMarketSession, sessionAllowsFills } from './marketSession';

describe('daily-bar fill-clock defect fix (Phase 14 walk-forward)', () => {
  // Real Alpaca 1Day bar timestamp confirmed during Phase 14 investigation: midnight America/New_York.
  const REAL_MIDNIGHT_ET_DAILY_BAR_MS = 1779163200000; // 2026-05-19T04:00:00.000Z = 2026-05-19T00:00:00 ET

  it('proves the root cause: an unshifted midnight daily-bar timestamp always classifies as CLOSED and blocks fills', () => {
    const session = classifyMarketSession(REAL_MIDNIGHT_ET_DAILY_BAR_MS, 'America/New_York', false);
    expect(session).toBe('CLOSED');
    expect(sessionAllowsFills(session, false)).toBe(false);
  });

  it('computeReplayFillClockMs shifts a 1Day-frequency midnight bar timestamp into the regular session window', () => {
    const shifted = computeReplayFillClockMs(REAL_MIDNIGHT_ET_DAILY_BAR_MS, '1Day', 'America/New_York', false);
    const session = classifyMarketSession(shifted, 'America/New_York', false);
    expect(session).toBe('REGULAR');
    expect(sessionAllowsFills(session, false)).toBe(true);
  });

  it('does not touch intraday-frequency timestamps - they already carry a real time-of-day', () => {
    const intraday = Date.UTC(2024, 0, 2, 14, 30, 0); // 9:30am ET
    expect(computeReplayFillClockMs(intraday, '1m', 'America/New_York', false)).toBe(intraday);
    expect(computeReplayFillClockMs(intraday, '5m', 'America/New_York', false)).toBe(intraday);
    expect(computeReplayFillClockMs(intraday, '1h', 'America/New_York', false)).toBe(intraday);
  });

  it('does NOT shift a 1Day-labeled bar that is already at a valid market-open timestamp (matches loadGoldenReplayDataset\'s fixture convention) - guards against double-shifting an already-correct timestamp into AFTER_HOURS/CLOSED', () => {
    const alreadyMarketOpen = Date.UTC(2024, 0, 2, 14, 30, 0); // 9:30am ET, labeled '1Day' by the golden fixture
    expect(computeReplayFillClockMs(alreadyMarketOpen, '1Day', 'America/New_York', false)).toBe(alreadyMarketOpen);
  });

  it('leaves a weekend daily-bar timestamp CLOSED - the 12h shift never crosses into a different weekday from midnight', () => {
    const saturdayMidnightEt = Date.UTC(2026, 4, 16, 4, 0, 0); // 2026-05-16 is a Saturday
    const shifted = computeReplayFillClockMs(saturdayMidnightEt, '1Day', 'America/New_York', false);
    expect(classifyMarketSession(shifted, 'America/New_York', false)).toBe('CLOSED');
  });

  it('shift lands in REGULAR on trading days immediately after both 2026 DST transitions', () => {
    // The transition Sunday itself is never a trading day, so real daily bars only ever appear on
    // the weekday immediately before/after it - confirm the shift is correct once the new UTC
    // offset is in effect.
    const dayAfterSpringForward = Date.UTC(2026, 2, 9, 4, 0, 0); // Mon 2026-03-09, EDT (UTC-4) midnight ET
    const dayAfterFallBack = Date.UTC(2026, 10, 2, 5, 0, 0); // Mon 2026-11-02, EST (UTC-5) midnight ET
    for (const t of [dayAfterSpringForward, dayAfterFallBack]) {
      const shifted = computeReplayFillClockMs(t, '1Day', 'America/New_York', false);
      expect(classifyMarketSession(shifted, 'America/New_York', false)).toBe('REGULAR');
    }
  });

  it('is keyed off the shared expectedStepMs frequency classifier, not a duplicated string check', () => {
    expect(computeReplayFillClockMs(REAL_MIDNIGHT_ET_DAILY_BAR_MS, '1d', 'America/New_York', false)).toBe(
      computeReplayFillClockMs(REAL_MIDNIGHT_ET_DAILY_BAR_MS, '1Day', 'America/New_York', false),
    );
    expect(computeReplayFillClockMs(REAL_MIDNIGHT_ET_DAILY_BAR_MS, 'day', 'America/New_York', false)).toBe(
      computeReplayFillClockMs(REAL_MIDNIGHT_ET_DAILY_BAR_MS, '1Day', 'America/New_York', false),
    );
  });
});
