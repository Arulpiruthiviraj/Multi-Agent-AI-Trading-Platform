/**
 * 2026-10-14 universal-discovery review, defect CANDIDATE: stale broad-universe cache evidence.
 *
 * getCachedBroadUniverseGapPct() / getCachedBroadUniverseCandidatesWithVolume() return whatever the LAST successful refresh produced, with no age
 * limit (the TTL variable in getCachedBroadUniverseSymbols() is read but both branches return the same value). OpportunityDiscovery's challenger
 * score (priorityScoreOf -> scoreBroadUniverseChallenger) multiplies that gapPct by broadUniverseGapHotSwapWeight, so a +8 % reading from 10:00
 * keeps competing as if current after refreshes fail at 10:15 / 10:30 / 10:45. Age is only RECORDED (gapEvidenceAgeMs) for observability.
 *
 * Part 1 (characterization, passes today) proves the behaviour. Part 2 (`it.fails`) states the policy that stale evidence must not be served as
 * fresh priority evidence; it is expected to FAIL until the defect is repaired, and flips to an error the day it is fixed (remove `.fails` then).
 * Universe MEMBERSHIP (the symbol is still known) is a separate matter from FRESH PRIORITY EVIDENCE (its stale gap).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { continuousIntelligence } from '../config/continuousIntelligence';
import { getTradingDateStr } from '../core/TradingCalendar';

vi.mock('../core/alpacaTls', () => ({ alpacaFetch: vi.fn() }));
import { alpacaFetch } from '../core/alpacaTls';
import {
  refreshBroadUniverseCache, getCachedBroadUniverseGapPct, getCachedBroadUniverseCandidatesWithVolume,
  getCachedBroadUniverseSnapshotFetchedAt, resetMarketUniverseScannerForTests,
} from './MarketUniverseScanner';

const FLAG = continuousIntelligence.broadUniverseEnabledEnvVar;
const mockFetch = alpacaFetch as unknown as ReturnType<typeof vi.fn>;
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, headers: { get: () => null } }) as any;

function completedBars(volumes: number[]) {
  const cursor = new Date(`${getTradingDateStr(new Date(Date.now()))}T12:00:00Z`);
  return Array.from({ length: continuousIntelligence.broadUniverseAdvLookbackDays }, (_, i) => {
    do { cursor.setUTCDate(cursor.getUTCDate() - 1); } while ([0, 6].includes(cursor.getUTCDay()));
    return { t: cursor.toISOString(), v: volumes[i % volumes.length] };
  });
}

afterEach(() => { vi.restoreAllMocks(); delete process.env[FLAG]; mockFetch.mockReset(); resetMarketUniverseScannerForTests(); });

async function warmCacheWithEightPercentMover(t0: number) {
  process.env[FLAG] = 'true';
  vi.spyOn(Date, 'now').mockReturnValue(t0);
  mockFetch.mockResolvedValueOnce(json([{ symbol: 'ABCD', exchange: 'NASDAQ', status: 'active', tradable: true, class: 'us_equity' }]));
  mockFetch.mockResolvedValueOnce(json({
    ABCD: {
      latestTrade: { p: 54, t: new Date(t0 - 60_000).toISOString() },
      dailyBar: { o: 50, c: 54, v: 2_000_000, h: 54, l: 50, t: '2026-09-17T04:00:00Z' },
      prevDailyBar: { c: 50, t: '2026-09-16T04:00:00Z' },
      latestQuote: { bp: 53.95, ap: 54.05 },
    },
  }));
  mockFetch.mockResolvedValueOnce(json({ bars: { ABCD: completedBars([900_000, 900_000]) } }));
  await refreshBroadUniverseCache();
}

describe('stale broad-universe evidence (defect candidate)', () => {
  it('CHARACTERIZATION: 45 minutes after the last successful refresh (3x the 15-minute TTL), the old gap and candidate row are still served', async () => {
    const t0 = Date.parse('2026-09-17T14:00:00Z');
    await warmCacheWithEightPercentMover(t0);
    const fresh = getCachedBroadUniverseGapPct('ABCD');
    expect(fresh).not.toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 3 * continuousIntelligence.broadUniverseSnapshotCacheTtlMs); // refresh keeps failing; nothing re-fetches
    expect(getCachedBroadUniverseGapPct('ABCD')).toBe(fresh);                       // old evidence unchanged
    expect(getCachedBroadUniverseCandidatesWithVolume().find((c) => c.symbol === 'ABCD')?.gapPct).toBe(fresh);
    expect(Date.now() - (getCachedBroadUniverseSnapshotFetchedAt() as number)).toBeGreaterThan(2 * continuousIntelligence.broadUniverseSnapshotCacheTtlMs); // it IS old
  });

  it.fails('POLICY (expected to fail until repaired): evidence older than the cache TTL must not be served as a usable gap for priority scoring', async () => {
    const t0 = Date.parse('2026-09-17T14:00:00Z');
    await warmCacheWithEightPercentMover(t0);
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 3 * continuousIntelligence.broadUniverseSnapshotCacheTtlMs);
    expect(getCachedBroadUniverseGapPct('ABCD')).toBeNull();                        // stale -> unknown, never "fresh"
    expect(getCachedBroadUniverseCandidatesWithVolume().find((c) => c.symbol === 'ABCD')?.gapPct ?? null).toBeNull();
  });
});
