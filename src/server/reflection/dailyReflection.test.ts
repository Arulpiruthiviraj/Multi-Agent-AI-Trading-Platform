/**
 * dailyReflection tests (2026-10-06, local-only, Part B workstream H).
 * Uses the isolated test DB (vitest.setup.ts sets ARGUS_DB_PATH before imports);
 * provider and evidence store are injected fakes - no network.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { db, sqliteDb } from '../db';
import * as schema from '../db/schema';
import { eq } from 'drizzle-orm';
import {
  runDailyReflection,
  getMoverCoverage,
  callOutcomeAudits,
  computeSessionMetrics,
} from './dailyReflection';
import type { MoverDataProvider, MoverScreenConfig, SnapshotEvidence, DailyBarEvidence } from './moverCohort';
import type { CoverageEvidenceStore } from './coverageReconciler';

const TEST_CFG: MoverScreenConfig = {
  minPrice: 5, maxPrice: 10000, minDollarVolume: 5_000_000,
  maxSpreadBps: 50, minAdvShares: 500_000, fetchTopNPerSide: 10, scanTopNPerSide: 20,
};


function fakeProvider(): MoverDataProvider {
  const snaps: Record<string, SnapshotEvidence> = {
    AAA: { symbol: 'AAA', price: 120, dollarVolume: 50_000_000, spreadBps: 8, spreadCrossed: false },
    BBB: { symbol: 'BBB', price: 60, dollarVolume: 30_000_000, spreadBps: 9, spreadCrossed: false },
    DDD: { symbol: 'DDD', price: 80, dollarVolume: 40_000_000, spreadBps: 7, spreadCrossed: false },
  };
  const bars: Record<string, DailyBarEvidence> = {
    AAA: { prevClose: 100, close: 125, volume: 1_000_000 },
    BBB: { prevClose: 50, close: 44, volume: 2_000_000 },
    DDD: { prevClose: 200, close: 210, volume: 800_000 },
  };
  const adv: Record<string, number> = { AAA: 2_000_000, BBB: 2_000_000, DDD: 2_000_000 };
  return {
    name: 'fake',
    isAvailable: () => true,
    fetchRawMovers: async () => ({
      gainers: [
        { symbol: 'AAA', percentChange: 25, price: 125 },
        { symbol: 'DDD', percentChange: 5, price: 210 },
      ],
      losers: [{ symbol: 'BBB', percentChange: -12, price: 44 }],
    }),
    fetchTradableAssetSymbols: async () => ['AAA', 'BBB', 'DDD'],
    fetchSnapshots: async (symbols) => {
      const out = new Map<string, SnapshotEvidence>();
      for (const s of symbols) if (snaps[s]) out.set(s, snaps[s]);
      return out;
    },
    fetchDailyBars: async (symbols, _tradingDate) => {
      const out = new Map<string, DailyBarEvidence>();
      for (const s of symbols) if (bars[s]) out.set(s, bars[s]);
      return out;
    },
    fetchAdvShares: async (symbols) => {
      const out = new Map<string, number>();
      for (const s of symbols) if (adv[s] != null) out.set(s, adv[s]);
      return out;
    },
  };
}

/** Empty evidence: every mover is a genuine NEVER_SEEN. */
function emptyStore(): CoverageEvidenceStore {
  return {
    getDiscoveryDecisions: async () => [],
    getNewsEventCount: async () => 0,
    getSubscribeCounts: async () => ({ requested: 0, acknowledged: 0 }),
    getQuantAssessmentCount: async () => 0,
    getIdeaEventCount: async () => 0,
    getConsensusTerminalRejected: async () => ({ rejected: false, reason: null }),
    getConsensusTraces: async () => [],
    getRiskAssessments: async () => [],
    getFillsAndOrders: async () => ({ orders: 0, fills: 0 }),
    getMissedOpportunity: async () => null,
    getTradePlans: async () => [],
    getFocusSymbols: async () => null,
    getFastLaneEventCount: async () => 0,
    moversFunnelRan: async () => true,
    getScanTopNPerSide: () => TEST_CFG.scanTopNPerSide,
  };
}

const unavailableProvider: MoverDataProvider = { ...fakeProvider(), isAvailable: () => false, name: 'fake-off' };

async function countCoverage(date: string): Promise<number> {
  const row = sqliteDb.prepare('SELECT COUNT(*) c FROM mover_coverage WHERE trading_date = ?').get(date) as { c: number };
  return row.c;
}

describe('dailyReflection', () => {
  beforeAll(() => {
    // Defensive: the worker-wiring test must see "no provider keys".
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;
  });

  it('migration 0093 created the mover_coverage table with the UNIQUE(trading_date, symbol) constraint', () => {
    const table = sqliteDb.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='mover_coverage'`).get();
    expect(table).toBeTruthy();
    const idx = sqliteDb.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_mover_coverage_date_symbol'`).get() as { sql: string };
    expect(idx.sql).toMatch(/UNIQUE/i);
  });

  it('missing provider data -> INSUFFICIENT_EVIDENCE, zero rows, never fabricated', async () => {
    const result = await runDailyReflection('2026-10-05', { provider: unavailableProvider, store: emptyStore() });
    expect(result.cohortStatus).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.cohortReason).toMatch(/ALPACA_API_KEY/);
    expect(result.moversConsidered).toBe(0);
    expect(result.rowsPersisted).toBe(0);
    expect(await countCoverage('2026-10-05')).toBe(0);
  });

  it('backfill for a past date (2026-10-05) reconciles and persists every mover', async () => {
    const result = await runDailyReflection('2026-10-05', { provider: fakeProvider(), store: emptyStore() });
    expect(result.cohortStatus).toBe('OK');
    expect(result.moversConsidered).toBe(3);
    expect(result.rowsPersisted).toBe(3);
    expect(result.fateCounts['NEVER_SEEN']).toBe(3);

    const rows = await getMoverCoverage('2026-10-05');
    expect(rows).toHaveLength(3);
    const aaa = rows.find((r) => r.symbol === 'AAA')!;
    expect(aaa.primaryFate).toBe('NEVER_SEEN');
    expect(aaa.eodMovePct).toBeCloseTo(25, 6);
    expect(aaa.referencePrice).toBe(100);
    expect(aaa.neverSeenCause).toBe('OTHER');
    expect(JSON.parse(aaa.secondaryReasons)).toBeInstanceOf(Array);
    // premarket_known_by contract keys (workstream I's wired outcome audit may
    // enrich the JSON with timestamps/sources - the 4 contract keys stay authoritative).
    const knownBy = JSON.parse(aaa.premarketKnownBy);
    expect(knownBy.plan0400).toBe(false);
    expect(knownBy.refresh0915).toBe(false);
    expect(knownBy.fastLane).toBe(false);
    expect(knownBy.discovery).toBe(false);
    const windows = JSON.parse(aaa.outcomeWindows!);
    expect(windows.eod.movePct).toBeCloseTo(25, 6);
    const bbb = rows.find((r) => r.symbol === 'BBB')!;
    expect(bbb.eodMovePct).toBeCloseTo(-12, 6);
  });

  it('re-running for the same date is idempotent (UNIQUE constraint, no duplicates)', async () => {
    const first = await runDailyReflection('2026-10-05', { provider: fakeProvider(), store: emptyStore() });
    const second = await runDailyReflection('2026-10-05', { provider: fakeProvider(), store: emptyStore() });
    expect(first.rowsPersisted).toBe(3);
    expect(second.rowsPersisted).toBe(3);
    expect(await countCoverage('2026-10-05')).toBe(3);
    expect(second.fateCounts).toEqual(first.fateCounts);
  });

  it('same-date path works for the current trading date (live screener branch)', async () => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const today = `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}-${parts.find((p) => p.type === 'day')!.value}`;
    const result = await runDailyReflection(today, { provider: fakeProvider(), store: emptyStore() });
    expect(result.cohortStatus).toBe('OK');
    expect(result.moversConsidered).toBe(3);
    expect(result.rowsPersisted).toBe(3);
    expect(await countCoverage(today)).toBe(3);
  });

  it('rejects a malformed trading date', async () => {
    await expect(runDailyReflection('yesterday', { provider: fakeProvider(), store: emptyStore() })).rejects.toThrow(/invalid tradingDate/);
  });

  it('sibling-workstream hooks never break the reflection run', async () => {
    // callOutcomeAudits is wired to workstream I's outcomeAudits.ts (async, failure-contained);
    // computeSessionMetrics is still a no-op pending workstream K. Neither may throw.
    await expect(callOutcomeAudits('2026-10-05')).resolves.toBeUndefined();
    expect(() => computeSessionMetrics('2026-10-05')).not.toThrow();
  });

  it('PostMarketAnalysisWorker runs reflection once per date after close (wiring)', async () => {
    const { PostMarketAnalysisWorker } = await import('../continuous/PostMarketAnalysis');
    const worker = new PostMarketAnalysisWorker();
    // 2026-10-08T01:30Z = 2026-10-07 21:30 EDT -> after close. Uses 2026-10-07
    // (distinct from the same-date test's rows) to keep the assertion isolated.
    await worker.tick(new Date('2026-10-08T01:30:00Z'));
    const reports = await db.select().from(schema.postmarketReports).where(eq(schema.postmarketReports.tradingDate, '2026-10-07'));
    expect(reports).toHaveLength(1);
    expect(reports[0].status).toBe('COMPLETED');
    // No provider keys in this environment -> honest INSUFFICIENT_EVIDENCE, nothing persisted.
    expect(await countCoverage('2026-10-07')).toBe(0);
    // Second tick: report upsert stays single-row, reflection memoized, no throw.
    await worker.tick(new Date('2026-10-08T02:00:00Z'));
    const reports2 = await db.select().from(schema.postmarketReports).where(eq(schema.postmarketReports.tradingDate, '2026-10-07'));
    expect(reports2).toHaveLength(1);
    expect(await countCoverage('2026-10-07')).toBe(0);
    worker.stop();
  });
});
