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

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `argus-snapshot-ranking-${Date.now()}-${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.ARGUS_DB_PATH;
    vi.doUnmock('../core/alpacaTls');
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* */ }
    }
  });

  it('persists a candidate_rankings row for a real scanned symbol without altering the existing return value', async () => {
    const fakeSnapshot = {
      AAPL: {
        minuteBar: { c: 150, h: 151, l: 149, v: 1000 },
        dailyBar: { c: 149, v: 40_000_000, o: 148 },
        prevDailyBar: { c: 145, v: 30_000_000 },
        latestTrade: { p: 150 },
      },
    };
    vi.doMock('../core/alpacaTls', () => ({
      alpacaFetch: vi.fn(async () => new Response(JSON.stringify(fakeSnapshot), { status: 200 })),
    }));
    vi.doMock('../config/continuousIntelligence', async (importOriginal) => {
      const actual = await importOriginal<any>();
      return {
        ...actual,
        continuousIntelligence: { ...actual.continuousIntelligence, seedSymbols: ['AAPL'], watchUniverseSymbols: [], campaignOpeningSurgeSymbols: [], momentumScanUniverseSymbols: [] },
      };
    });

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
});
