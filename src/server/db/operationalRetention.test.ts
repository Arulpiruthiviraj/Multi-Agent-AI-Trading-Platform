import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Real integration test (isolated temp SQLite DB, real migrations, no mocks) for the real defect
 * fixed 2026-09-22: candidate_rankings had zero retention anywhere in the codebase (confirmed via
 * a live production DB query - 1.38M+ rows, 26 days, unbounded growth) while observability_events
 * already had a working sweep. This proves sweepCandidateRankingsRetention() actually deletes rows
 * older than the configured cutoff and leaves newer rows untouched.
 */
describe('sweepCandidateRankingsRetention (real defect: candidate_rankings had no retention policy)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let sweepCandidateRankingsRetention: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_retention_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('./index'));
    schema = await import('./schema');
    ({ sweepCandidateRankingsRetention } = await import('./operationalRetention'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  function row(symbol: string, cycleAt: string) {
    return {
      symbol,
      cycleAt,
      componentAvailability: '{}',
      weightsUsed: '{}',
      finalScore: 0.5,
      rank: 1,
      promotionRecommendation: 'HOLD',
      promotionReason: 'test fixture',
      createdAt: cycleAt,
    };
  }

  it('deletes only rows older than the configured retention window', async () => {
    const now = Date.now();
    const oldIso = new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString(); // 20 days old - past a 14-day cutoff
    const recentIso = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day old - inside it

    await db.insert(schema.candidateRankings).values(row('OLD1', oldIso));
    await db.insert(schema.candidateRankings).values(row('OLD2', oldIso));
    await db.insert(schema.candidateRankings).values(row('RECENT1', recentIso));

    const deleted = await sweepCandidateRankingsRetention(now);

    expect(deleted).toBe(2);
    const remaining = await db.select().from(schema.candidateRankings);
    expect(remaining.map((r: any) => r.symbol).sort()).toEqual(['RECENT1']);
  });

  it('is a safe no-op when nothing is old enough to prune', async () => {
    const now = Date.now();
    const deleted = await sweepCandidateRankingsRetention(now);
    expect(deleted).toBe(0);
    const remaining = await db.select().from(schema.candidateRankings);
    expect(remaining.map((r: any) => r.symbol)).toEqual(['RECENT1']);
  });
});
