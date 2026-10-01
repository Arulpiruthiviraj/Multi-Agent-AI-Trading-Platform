// @ts-nocheck
import { describe, it, expect, afterEach, vi } from 'vitest';
import { continuousIntelligence } from '../config/continuousIntelligence';
import {
  scoreSnapshotCandidate,
  getTopMomentumCandidates,
  getSnapshotScanUniverse,
  setSnapshotRanksForTests,
  resetSnapshotScannerForTests,
  isSnapshotScannerRth,
  expectedVolumeAtTimeOfDay,
  minutesSinceRthOpen,
} from './SnapshotScanner';

afterEach(() => {
  resetSnapshotScannerForTests();
  vi.restoreAllMocks();
});

describe('SnapshotScanner', () => {
  it('curates 100+ liquid symbols and keeps anchors in the pool', () => {
    const universe = getSnapshotScanUniverse();
    expect(universe.length).toBeGreaterThanOrEqual(100);
    expect(universe).toEqual(expect.arrayContaining(['NVDA', 'TSLA', 'DIA', 'SOXL', 'TQQQ']));
  });

  it('scores abs(% change), RVOL, and range expansion with the documented weights', () => {
    // Mid-session so expected volume ≈ half of prior day
    const now = new Date('2026-08-21T15:00:00.000Z'); // 11:00 ET
    const mins = minutesSinceRthOpen(now);
    expect(mins).toBeGreaterThan(60);

    const row = scoreSnapshotCandidate({
      symbol: 'NVDA',
      last: 110,
      prevClose: 100,
      minuteHigh: 111,
      minuteLow: 109,
      minuteClose: 110,
      dailyVolume: 5_000_000,
      prevDayVolume: 10_000_000,
    }, now);

    expect(row).not.toBeNull();
    expect(row!.intradayPctChange).toBeCloseTo(10, 5);
    // rangeExpansion = (111-109)/110
    expect(row!.rangeExpansion).toBeCloseTo(2 / 110, 5);
    const expected = expectedVolumeAtTimeOfDay(10_000_000, now)!;
    expect(row!.relativeVolume).toBeCloseTo(5_000_000 / expected, 5);
    const expectedScore =
      (Math.abs(10) * 0.5)
      + (row!.relativeVolume * 0.3)
      + (row!.rangeExpansion * 0.2);
    expect(row!.momentumScore).toBeCloseTo(expectedScore, 5);
  });

  it('getTopMomentumCandidates excludes permanent anchors and sorts descending', async () => {
    setSnapshotRanksForTests([
      {
        symbol: 'SPY',
        intradayPctChange: 9,
        rangeExpansion: 0.01,
        relativeVolume: 3,
        momentumScore: 99,
      },
      {
        symbol: 'QQQ',
        intradayPctChange: 8,
        rangeExpansion: 0.01,
        relativeVolume: 3,
        momentumScore: 98,
      },
      {
        symbol: 'GLD',
        intradayPctChange: 7,
        rangeExpansion: 0.01,
        relativeVolume: 3,
        momentumScore: 97,
      },
      {
        symbol: 'TSLA',
        intradayPctChange: 5,
        rangeExpansion: 0.02,
        relativeVolume: 2,
        momentumScore: 50,
      },
      {
        symbol: 'AMD',
        intradayPctChange: 4,
        rangeExpansion: 0.02,
        relativeVolume: 2.5,
        momentumScore: 60,
      },
      {
        symbol: 'MARA',
        intradayPctChange: 3,
        rangeExpansion: 0.03,
        relativeVolume: 4,
        momentumScore: 40,
      },
    ]);

    const top = await getTopMomentumCandidates(2, { cachedOnly: true });
    expect(top.map((t) => t.symbol)).toEqual(['AMD', 'TSLA']);
    expect(top.every((t) => !continuousIntelligence.coreStreamingSymbols.includes(t.symbol))).toBe(true);
  });

  it('RTH detector is true mid-session weekday and false on weekend', () => {
    // Friday 2026-08-21 14:00 UTC = 10:00 ET
    expect(isSnapshotScannerRth(new Date('2026-08-21T14:00:00.000Z'))).toBe(true);
    // Saturday
    expect(isSnapshotScannerRth(new Date('2026-08-22T14:00:00.000Z'))).toBe(false);
    // Friday after close 21:00 UTC = 17:00 ET
    expect(isSnapshotScannerRth(new Date('2026-08-21T21:00:00.000Z'))).toBe(false);
  });

  describe('premarket RVOL fabrication fix (2026-09-27, ARGUS_MISSED_OPPORTUNITY_REDESIGN_PLAN.md WP2)', () => {
    // Friday 2026-08-21. 08:00 UTC = 4:00am ET, 11:00 UTC = 7:00am ET, 13:15 UTC = 9:15am ET —
    // all genuinely premarket (before the 09:30 ET open).
    const premarketTimes = [
      new Date('2026-08-21T08:00:00.000Z'), // 4:00am ET
      new Date('2026-08-21T11:00:00.000Z'), // 7:00am ET
      new Date('2026-08-21T13:15:00.000Z'), // 9:15am ET
    ];

    it('expectedVolumeAtTimeOfDay returns null (not the old fabricated 2%-floor value) for distinct premarket times', () => {
      for (const t of premarketTimes) {
        expect(isSnapshotScannerRth(t)).toBe(false);
        // Old (buggy) behavior would have returned 10_000_000 * 0.02 = 200_000 for every one of
        // these timestamps regardless of how far before the open they were — a fabricated,
        // time-invariant number. The fix must return null (honestly unavailable) instead.
        const result = expectedVolumeAtTimeOfDay(10_000_000, t);
        expect(result).toBeNull();
      }
    });

    it('REGULAR-session expectedVolumeAtTimeOfDay behavior is completely unchanged', () => {
      // Early-session: 09:35 ET (13:35 UTC) — frac is tiny, exercises the 2% floor, which must
      // still apply DURING the regular session (this is the one case where a floor is legitimate).
      const earlySession = new Date('2026-08-21T13:35:00.000Z');
      expect(isSnapshotScannerRth(earlySession)).toBe(true);
      expect(expectedVolumeAtTimeOfDay(10_000_000, earlySession)).toBeCloseTo(10_000_000 * 0.02, 5);

      // Late-session: 15:30 ET (19:30 UTC) — well past the floor, frac should dominate.
      const lateSession = new Date('2026-08-21T19:30:00.000Z');
      expect(isSnapshotScannerRth(lateSession)).toBe(true);
      const mins = minutesSinceRthOpen(lateSession);
      const expectedFrac = mins / 390;
      expect(expectedVolumeAtTimeOfDay(10_000_000, lateSession)).toBeCloseTo(10_000_000 * expectedFrac, 5);
    });

    it('scoreSnapshotCandidate marks relativeVolume unavailable (not coerced to 0-as-real or NaN) during premarket', () => {
      for (const t of premarketTimes) {
        const row = scoreSnapshotCandidate({
          symbol: 'AMD',
          last: 110,
          prevClose: 100,
          minuteHigh: 111,
          minuteLow: 109,
          minuteClose: 110,
          dailyVolume: 5_000_000,
          prevDayVolume: 10_000_000,
        }, t);
        expect(row).not.toBeNull();
        // Old (buggy) behavior: relativeVolume = 5_000_000 / (10_000_000 * 0.02) = 25 (a fabricated
        // ~25x "RVOL" purely from clock time, matching the documented 92.37x AMD case study's
        // shape). The honest result is "unavailable", surfaced as relativeVolumeAvailable=false —
        // downstream (ComposableRanking.computeDeterministicComponents) excludes it from the score
        // rather than treating the placeholder 0 as a real zero RVOL observation.
        expect(row!.relativeVolumeAvailable).toBe(false);
        expect(row!.relativeVolume).toBe(0);
        expect(Number.isNaN(row!.momentumScore)).toBe(false);
      }
    });

    it('scoreSnapshotCandidate keeps REGULAR-session relativeVolume behavior unchanged', () => {
      const now = new Date('2026-08-21T15:00:00.000Z'); // 11:00 ET, mid-session
      const row = scoreSnapshotCandidate({
        symbol: 'NVDA',
        last: 110,
        prevClose: 100,
        minuteHigh: 111,
        minuteLow: 109,
        minuteClose: 110,
        dailyVolume: 5_000_000,
        prevDayVolume: 10_000_000,
      }, now);
      expect(row).not.toBeNull();
      expect(row!.relativeVolumeAvailable).toBe(true);
      const expected = expectedVolumeAtTimeOfDay(10_000_000, now)!;
      expect(row!.relativeVolume).toBeCloseTo(5_000_000 / expected, 5);
    });
  });
});
