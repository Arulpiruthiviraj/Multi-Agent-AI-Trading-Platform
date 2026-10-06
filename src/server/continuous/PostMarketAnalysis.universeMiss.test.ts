import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * TRUE_UNIVERSE_MISS wiring proof (2026-10-06, workstream K): the taxonomy code was
 * IMPLEMENTED_BUT_UNREACHED until workstream H's mover_coverage reconciliation landed
 * (migration 0093). These tests prove readNeverSeenMovers() genuinely populates it from
 * real NEVER_SEEN rows - and that a symbol with any discovery event is never mislabeled
 * as never-seen.
 */
describe('PostMarketAnalysis TRUE_UNIVERSE_MISS (H reconciliation wiring)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./PostMarketAnalysis');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_universemiss_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./PostMarketAnalysis');
  });

  afterAll(() => {
    vi.resetModules();
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  const tradingDate = '2026-10-05';
  const sinceIso = `${tradingDate}T00:00:00.000Z`;
  const sinceMs = new Date(sinceIso).getTime();

  it('classifies a reconciled NEVER_SEEN mover as TRUE_UNIVERSE_MISS with its real cause', async () => {
    await db.insert(schema.moverCoverage).values({
      tradingDate,
      symbol: 'GHOST',
      eodMovePct: 12.5,
      primaryFate: 'NEVER_SEEN',
      neverSeenCause: 'NEWS_SOURCE_COVERAGE',
      createdAt: sinceIso,
    });

    const rows = mod.readNeverSeenMovers(tradingDate);
    expect(rows).toEqual([{ symbol: 'GHOST', neverSeenCause: 'NEWS_SOURCE_COVERAGE' }]);

    const report = await mod.generatePostMarketReport(tradingDate);
    const finding = report.findings.find((f) => f.symbol === 'GHOST');
    expect(finding).toBeDefined();
    expect(finding!.classification).toBe('TRUE_UNIVERSE_MISS');
    expect(finding!.classificationRationale).toContain('NEWS_SOURCE_COVERAGE');
  });

  it('does not label a NEVER_SEEN mover as never-seen when discovery events exist for it', async () => {
    await db.insert(schema.moverCoverage).values({
      tradingDate,
      symbol: 'SEEN',
      eodMovePct: 9.1,
      primaryFate: 'NEVER_SEEN',
      neverSeenCause: 'RANK_CAP',
      createdAt: sinceIso,
    });
    await db.insert(schema.observabilityEvents).values({
      id: 'ev-seen-1', ts: sinceMs + 1000, level: 'INFO', category: 'DISCOVERY',
      eventType: 'DISCOVERY_CANDIDATE_FILTERED', loggerName: 'argus',
      message: 'discovery_candidate_decision', sessionId: 'sess-u', symbol: 'SEEN',
      payload: JSON.stringify({ source: 'MARKET_MOVER', reason: 'PRICE', price: 1.5, dollarVolume: 900, spreadBps: 400, advShares: null, gapMover: false, gapPct: null, rvolMover: false, rvol: null }),
    });

    const report = await mod.generatePostMarketReport(tradingDate);
    const finding = report.findings.find((f) => f.symbol === 'SEEN');
    expect(finding).toBeDefined();
    // Seen by definition (a real discovery event exists) -> the PRICE filter classification wins.
    expect(finding!.classification).toBe('CORRECT_NON_ACTION');
  });

  it('returns [] when mover_coverage has no NEVER_SEEN rows for the date', async () => {
    expect(mod.readNeverSeenMovers('2099-01-01')).toEqual([]);
  });
});
