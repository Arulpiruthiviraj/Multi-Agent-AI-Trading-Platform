// @ts-nocheck
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * 2026-09-30 (Discovery Challenger Observability Hardening,
 * ARGUS_CHALLENGER_SELECTION_FORENSIC_2026-09-29.md follow-up §8/§9). Real integration test
 * (isolated temp SQLite DB) seeding the exact real event shapes OpportunityDiscovery.ts emits -
 * never fabricated - matching the exact convention discoveryLineageReport.test.ts/
 * explorationHealthReport.test.ts already established.
 */
describe('discoveryChallengerReport', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./discoveryChallengerReport');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_discovery_challenger_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./discoveryChallengerReport');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  let seq = 0;
  function nextId(): string {
    seq += 1;
    return `dc-${seq}`;
  }

  it('an empty window produces an honest zero report, never fabricated', async () => {
    const report = await mod.buildDiscoveryChallengerReport(new Date(Date.now() - 60_000).toISOString());
    expect(report.cyclesConsidered).toBe(0);
    expect(report.totalAdmitted).toBe(0);
    expect(report.topMissedChallengers).toEqual([]);
    const text = mod.formatDiscoveryChallengerReport(report);
    expect(text).toContain('Cycles considered: 0');
  });

  it('aggregates a real per-cycle snapshot: admitted, positively scored, zero scored, and truncated candidates', async () => {
    const tsMs = Date.now();
    await db.insert(schema.observabilityEvents).values({
      id: nextId(), ts: tsMs, level: 'INFO', category: 'DISCOVERY', eventType: 'DISCOVERY_CHALLENGER_CYCLE_SNAPSHOT',
      loggerName: 'argus', message: 'discovery_challenger_cycle_snapshot', sessionId: 'test-session',
      payload: JSON.stringify({
        cycleId: 'cycle_test_1',
        totalShortlisted: 100,
        eligibleForChallengerScoring: 4,
        zeroScoreOrExcludedCount: 96,
        challengerLimit: 2,
        survivedTruncationCount: 2,
        candidates: [
          { symbol: 'AAAAA', discoverySource: 'BROAD_UNIVERSE', rankBeforeTruncation: 1, survivedTruncation: true },
          { symbol: 'BBBBB', discoverySource: 'BROAD_UNIVERSE', rankBeforeTruncation: 2, survivedTruncation: true },
          { symbol: 'CCCCC', discoverySource: 'BROAD_UNIVERSE', rankBeforeTruncation: 3, survivedTruncation: false },
          { symbol: 'DDDDD', discoverySource: 'MARKET_MOVER', rankBeforeTruncation: 4, survivedTruncation: false },
        ],
      }),
    });

    const report = await mod.buildDiscoveryChallengerReport(new Date(tsMs - 60_000).toISOString());
    expect(report.cyclesConsidered).toBe(1);
    expect(report.totalAdmitted).toBe(100);
    expect(report.totalPositivelyScored).toBe(4);
    expect(report.totalZeroScored).toBe(96);
    expect(report.totalTruncated).toBe(2); // 4 eligible - 2 survived
    const missedSymbols = report.topMissedChallengers.map((m) => m.symbol);
    expect(missedSymbols).toEqual(expect.arrayContaining(['CCCCC', 'DDDDD']));
    expect(missedSymbols).not.toContain('AAAAA'); // survived truncation - not a "missed" challenger
    const ccccc = report.topMissedChallengers.find((m) => m.symbol === 'CCCCC');
    expect(ccccc!.bestRank).toBe(3);
  });

  it('counts a cycle as swap-pacing-blocked only when a real, positive swap budget was fully consumed', async () => {
    const tsMs = Date.now();
    await db.insert(schema.observabilityEvents).values([
      {
        id: nextId(), ts: tsMs, level: 'INFO', category: 'DISCOVERY', eventType: 'DISCOVERY_CHALLENGER_SWAP_OUTCOME',
        loggerName: 'argus', message: 'discovery_challenger_swap_outcome', sessionId: 'test-session',
        payload: JSON.stringify({ cycleId: 'c1', effectiveSwapBudget: 1, swapsConsumed: 1, swapsRemaining: 0 }),
      },
      {
        id: nextId(), ts: tsMs, level: 'INFO', category: 'DISCOVERY', eventType: 'DISCOVERY_CHALLENGER_SWAP_OUTCOME',
        loggerName: 'argus', message: 'discovery_challenger_swap_outcome', sessionId: 'test-session',
        payload: JSON.stringify({ cycleId: 'c2', effectiveSwapBudget: 1, swapsConsumed: 0, swapsRemaining: 1 }),
      },
      {
        id: nextId(), ts: tsMs, level: 'INFO', category: 'DISCOVERY', eventType: 'DISCOVERY_CHALLENGER_SWAP_OUTCOME',
        loggerName: 'argus', message: 'discovery_challenger_swap_outcome', sessionId: 'test-session',
        payload: JSON.stringify({ cycleId: 'c3', effectiveSwapBudget: 0, swapsConsumed: 0, swapsRemaining: 0 }),
      },
    ]);

    const report = await mod.buildDiscoveryChallengerReport(new Date(tsMs - 60_000).toISOString());
    expect(report.cyclesBlockedBySwapPacing).toBe(1); // only c1: real positive budget, fully consumed
  });

  it('counts promoted / swap-cap-blocked / not-evictable from the real per-decision reasonCode, never from a free-text guess', async () => {
    const tsMs = Date.now();
    await db.insert(schema.observabilityEvents).values([
      {
        id: nextId(), ts: tsMs, level: 'INFO', category: 'DISCOVERY', eventType: 'SUBSCRIPTION_PROMOTED',
        loggerName: 'argus', message: 'subscription_priority_decision', sessionId: 'test-session', symbol: 'WINNR',
        payload: JSON.stringify({ reasonCode: 'CHALLENGER_SELECTED', promotedSymbol: 'WINNR', displacedSymbol: 'LOSER' }),
      },
      {
        id: nextId(), ts: tsMs, level: 'INFO', category: 'DISCOVERY', eventType: 'SUBSCRIPTION_NOT_PROMOTED',
        loggerName: 'argus', message: 'subscription_priority_decision', sessionId: 'test-session', symbol: 'CAPBL',
        payload: JSON.stringify({ reasonCode: 'SWAP_CAP_REACHED' }),
      },
      {
        id: nextId(), ts: tsMs, level: 'INFO', category: 'DISCOVERY', eventType: 'SUBSCRIPTION_NOT_PROMOTED',
        loggerName: 'argus', message: 'subscription_priority_decision', sessionId: 'test-session', symbol: 'NOEVC',
        payload: JSON.stringify({ reasonCode: 'INCUMBENT_NOT_EVICTABLE' }),
      },
    ]);

    const report = await mod.buildDiscoveryChallengerReport(new Date(tsMs - 60_000).toISOString());
    expect(report.totalPromoted).toBe(1);
    expect(report.totalSwapCapBlocked).toBe(1);
    expect(report.totalNotEvictable).toBe(1);
  });
});
