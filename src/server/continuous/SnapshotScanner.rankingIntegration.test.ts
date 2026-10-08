import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Phase 4C integration test: refreshSnapshotRanks() must persist a real candidate_rankings row
 * per scanned symbol via the additive runRankingCycle() call, WITHOUT changing its own existing
 * return value or lastStats contract (see SnapshotScanner.ts's own header comment on that call).
 */
describe('refreshSnapshotRanks -> composable ranking persistence', () => {
  let tmpDbPath: string;
  let snapshots: Record<string, unknown>;
  let connection: { close(): void };

  beforeEach(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus-snapshot-ranking-${Date.now()}-${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    vi.resetModules();
    // Database migrations/bootstrap are setup, not ranking latency. Let the existing hook
    // timeout cover cold bootstrap; retain the ordinary test deadline for behavior assertions.
    ({ sqliteDb: connection } = await import('../db'));
    snapshots = {};
    vi.doMock('../core/alpacaTls', () => ({
      alpacaFetch: vi.fn(async () => new Response(JSON.stringify(snapshots), { status: 200 })),
    }));
    vi.doMock('../config/continuousIntelligence', async (importOriginal) => {
      const actual = await importOriginal<any>();
      return { ...actual, continuousIntelligence: { ...actual.continuousIntelligence, seedSymbols: ['AAPL', 'MSFT'], watchUniverseSymbols: [], campaignOpeningSurgeSymbols: [], momentumScanUniverseSymbols: [] } };
    });
    await import('./SnapshotScanner');
    // refreshSnapshotRanks lazily loads these real collaborators. Include their cold module
    // initialization in setup too; no collaborator result is mocked or injected.
    await import('./ComposableRanking');
    await import('./TradePlanBuilder');
    await import('./MissedOpportunityDetector');
    await import('../services/MarketDataWorker');
    await import('../db/schema');
  });

  afterEach(() => {
    connection?.close();
    delete process.env.ARGUS_DB_PATH;
    vi.doUnmock('../config/continuousIntelligence');
    vi.doUnmock('../core/alpacaTls');
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* */ }
    }
  });

  it('persists a candidate_rankings row for a real scanned symbol without altering the existing return value', async () => {
    snapshots = {
      AAPL: {
        minuteBar: { c: 150, h: 151, l: 149, v: 1000 },
        dailyBar: { c: 149, v: 40_000_000, o: 148 },
        prevDailyBar: { c: 145, v: 30_000_000 },
        latestTrade: { p: 150 },
      },
    };

    const { db } = await import('../db');
    const { candidateRankings } = await import('../db/schema');
    const { refreshSnapshotRanks } = await import('./SnapshotScanner');

    const result = await refreshSnapshotRanks(new Date());
    expect(result.some((r) => r.symbol === 'AAPL')).toBe(true);

    const rows = await db.select().from(candidateRankings);
    const aaplRow = rows.find((r) => r.symbol === 'AAPL');
    expect(aaplRow).toBeDefined();
    expect(aaplRow!.finalScore).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(aaplRow!.componentAvailability).momentum.available).toBe(true);
  });

  /**
   * Phase 0 regression (P1 — SOURCE_VERIFIED, ARGUS_MASTER_REDESIGN_PLAN.md): refreshSnapshotRanks()
   * used to build `rankingInputs` by zipping the UNSORTED `scoredInputs` array against the
   * momentum-SORTED `scored` array via positional index (`scored[i]`). Once `scored` was reordered
   * by `scored.sort((a, b) => b.momentumScore - a.momentumScore)`, index i no longer pointed at the
   * same symbol in both arrays, so a low-momentum symbol could be persisted with a high-momentum
   * neighbor's raw momentum/relative-volume/range-expansion figures (and vice versa) in
   * `candidate_rankings`. The fix looks each symbol's own row up from a `Map<symbol, row>` built
   * BEFORE the sort, so order is irrelevant. This test forces the universe order and the
   * post-sort rank order to differ (AAPL scanned first but ranks last; MSFT scanned second but
   * ranks first) and asserts each symbol's persisted momentum/range-expansion score is its own,
   * not its neighbor's.
   */
  it('preserves each symbol\'s own raw momentum/range-expansion values when scan order and rank order differ', async () => {
    snapshots = {
      // Scanned first (universe order), but a small move -> ranks LAST after the momentum sort.
      AAPL: {
        minuteBar: { c: 100.5, h: 101, l: 100, v: 1_000_000 },
        dailyBar: { c: 100.5, v: 1_000_000, o: 100 },
        prevDailyBar: { c: 100, v: 50_000_000 },
        latestTrade: { p: 100.5 },
      },
      // Scanned second (universe order), but a huge move -> ranks FIRST after the momentum sort.
      MSFT: {
        minuteBar: { c: 120, h: 125, l: 115, v: 5_000_000 },
        dailyBar: { c: 120, v: 80_000_000, o: 100 },
        prevDailyBar: { c: 100, v: 50_000_000 },
        latestTrade: { p: 120 },
      },
    };


    const { db } = await import('../db');
    const { candidateRankings } = await import('../db/schema');
    const { refreshSnapshotRanks, scoreSnapshotCandidate } = await import('./SnapshotScanner');

    const now = new Date();
    const result = await refreshSnapshotRanks(now);

    // Sanity: the momentum sort really did reorder the two symbols relative to scan/universe order.
    const aaplResult = result.find((r) => r.symbol === 'AAPL')!;
    const msftResult = result.find((r) => r.symbol === 'MSFT')!;
    expect(msftResult.momentumScore).toBeGreaterThan(aaplResult.momentumScore);
    expect(result[0].symbol).toBe('MSFT'); // ranked first despite being scanned second
    expect(result[result.length - 1].symbol).toBe('AAPL'); // ranked last despite being scanned first

    // Independently recompute each symbol's own expected raw momentum/range-expansion (pure fn,
    // no sort involved) to know what "correct, unswapped" attribution looks like.
    const aaplExpected = scoreSnapshotCandidate(
      { symbol: 'AAPL', last: 100.5, prevClose: 100, minuteHigh: 101, minuteLow: 100, minuteClose: 100.5, dailyVolume: 1_000_000, prevDayVolume: 50_000_000 },
      now,
    )!;
    const msftExpected = scoreSnapshotCandidate(
      { symbol: 'MSFT', last: 120, prevClose: 100, minuteHigh: 125, minuteLow: 115, minuteClose: 120, dailyVolume: 80_000_000, prevDayVolume: 50_000_000 },
      now,
    )!;
    expect(aaplExpected.intradayPctChange).toBeLessThan(1);
    expect(msftExpected.intradayPctChange).toBeGreaterThan(15);

    const rows = await db.select().from(candidateRankings);
    const aaplRow = rows.find((r) => r.symbol === 'AAPL')!;
    const msftRow = rows.find((r) => r.symbol === 'MSFT')!;
    expect(aaplRow).toBeDefined();
    expect(msftRow).toBeDefined();

    const MOMENTUM_SCALE_CAP_PCT = 10;
    const expectedAaplMomentumScore = Math.min(1, Math.abs(aaplExpected.intradayPctChange) / MOMENTUM_SCALE_CAP_PCT);
    const expectedMsftMomentumScore = Math.min(1, Math.abs(msftExpected.intradayPctChange) / MOMENTUM_SCALE_CAP_PCT);

    // AAPL's own (small) momentum/range-expansion score must stay attached to AAPL, and MSFT's own
    // (large) score must stay attached to MSFT - never swapped by the sort.
    expect(aaplRow.momentumScore).toBeCloseTo(expectedAaplMomentumScore, 5);
    expect(msftRow.momentumScore).toBeCloseTo(expectedMsftMomentumScore, 5);
    expect(aaplRow.rangeExpansionScore).toBeCloseTo(aaplExpected.rangeExpansion, 5);
    expect(msftRow.rangeExpansionScore).toBeCloseTo(msftExpected.rangeExpansion, 5);
    expect(msftRow.momentumScore!).toBeGreaterThan(aaplRow.momentumScore!);
    expect(msftRow.rangeExpansionScore!).toBeGreaterThan(aaplRow.rangeExpansionScore!);
  });
});
