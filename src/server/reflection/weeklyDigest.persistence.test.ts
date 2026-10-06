import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Persistence tests for the weekly reflection digest (migration 0095).
 * Uses a throwaway SQLite file so the real database is never touched. Verifies the
 * migration SQL applies, the recurrence gate holds end-to-end, and re-runs upsert
 * rather than duplicating rows.
 */
describe('weeklyDigest persistence (0095)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let digest: typeof import('./weeklyDigest');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_weekly_digest_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    digest = await import('./weeklyDigest');
  });

  afterAll(() => {
    vi.resetModules();
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  async function insertCompletedReport(tradingDate: string, blindSpots: any[], findings: any[] = []) {
    await db.insert(schema.postmarketReports).values({
      id: tradingDate,
      tradingDate,
      generatedAt: `${tradingDate}T21:00:00.000Z`,
      argusCommit: null,
      totalSymbolsTouched: findings.length,
      byClassificationJson: JSON.stringify({}),
      findingsJson: JSON.stringify({ findings, narratives: [], flowScorecard: {}, blindSpots, rejectedCandidateAudits: [] }),
      status: 'COMPLETED',
      errorMessage: null,
    });
  }

  it('persists a recurring pattern and excludes one-day anomalies, end to end', async () => {
    const spot = (evidence: string) => ({
      patternKey: 'NULL_ADV_LIQUIDITY_GATE',
      pattern: 'null adv gate',
      affectedSymbolCount: 2,
      evidence,
    });
    const oneOff = (evidence: string) => ({
      patternKey: 'NEWS_TO_DISCOVERY_GAP',
      pattern: 'news gap',
      affectedSymbolCount: 1,
      evidence,
    });
    await insertCompletedReport('2026-10-05', [spot('AAA, BBB'), oneOff('ZZZ')]);
    await insertCompletedReport('2026-10-06', [spot('CCC')]);
    // A RUNNING (incomplete) report must not feed the digest.
    await db.insert(schema.postmarketReports).values({
      id: '2026-10-07',
      tradingDate: '2026-10-07',
      generatedAt: '2026-10-07T21:00:00.000Z',
      argusCommit: null,
      totalSymbolsTouched: 0,
      byClassificationJson: JSON.stringify({}),
      findingsJson: JSON.stringify({ findings: [], narratives: [], flowScorecard: {}, blindSpots: [spot('QQQ')], rejectedCandidateAudits: [] }),
      status: 'RUNNING',
      errorMessage: null,
    });

    const patterns = await digest.computeAndPersistWeeklyDigest('2026-10-05');
    expect(patterns.map((p) => p.patternKey)).toEqual(['NULL_ADV_LIQUIDITY_GATE']);
    expect(patterns[0].occurrences).toBe(2);
    expect(patterns[0].symbols).toEqual(['AAA', 'BBB', 'CCC']);
    expect(patterns[0].firstSeen).toBe('2026-10-05');
    expect(patterns[0].lastSeen).toBe('2026-10-06');

    const rows = await db.select().from(schema.weeklyReflectionDigest);
    expect(rows).toHaveLength(1);
    expect(rows[0].weekStart).toBe('2026-10-05');
    expect(rows[0].patternKey).toBe('NULL_ADV_LIQUIDITY_GATE');
    expect(rows[0].occurrences).toBe(2);
    expect(JSON.parse(rows[0].symbols)).toEqual(['AAA', 'BBB', 'CCC']);

    // Re-running for the same week upserts (no duplicate rows).
    await digest.computeAndPersistWeeklyDigest('2026-10-05');
    const rows2 = await db.select().from(schema.weeklyReflectionDigest);
    expect(rows2).toHaveLength(1);
  });

  it('weekStartMonday buckets dates to the Monday of their week', () => {
    expect(digest.weekStartMonday('2026-10-06')).toBe('2026-10-05'); // Tuesday -> Monday
    expect(digest.weekStartMonday('2026-10-05')).toBe('2026-10-05'); // Monday -> itself
    expect(digest.weekStartMonday('2026-10-11')).toBe('2026-10-05'); // Sunday -> Monday
  });
});
