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
});
