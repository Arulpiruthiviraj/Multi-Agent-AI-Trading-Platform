import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('/api/v2/continuous-intelligence/ranking/*', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_ranking_route_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    const { continuousIntelRouter } = await import('./continuousIntelRoutes');
    app = express();
    app.use('/api/v2/continuous-intelligence', continuousIntelRouter);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('GET /ranking/latest returns an empty cycle when nothing has been recorded', async () => {
    const res = await request(app).get('/api/v2/continuous-intelligence/ranking/latest');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.cycleAt).toBeNull();
    expect(res.body.candidates).toEqual([]);
  });

  it('GET /ranking/latest returns only the newest cycle, and /ranking/history/:symbol returns full history across cycles', async () => {
    const older = { cycleAt: '2026-08-26T10:00:00.000Z', createdAt: '2026-08-26T10:00:00.000Z' };
    const newer = { cycleAt: '2026-08-26T10:05:00.000Z', createdAt: '2026-08-26T10:05:00.000Z' };
    const baseRow = {
      componentAvailability: JSON.stringify({ momentum: { available: true } }),
      weightsUsed: JSON.stringify({ momentum: 1 }),
      promotionRecommendation: 'HOLD',
      promotionReason: 'test',
    };
    await db.insert(schema.candidateRankings).values({ ...baseRow, ...older, symbol: 'AAPL', finalScore: 0.5, rank: 1 });
    await db.insert(schema.candidateRankings).values({ ...baseRow, ...newer, symbol: 'AAPL', finalScore: 0.6, rank: 2 });
    await db.insert(schema.candidateRankings).values({ ...baseRow, ...newer, symbol: 'MSFT', finalScore: 0.8, rank: 1 });

    const latestRes = await request(app).get('/api/v2/continuous-intelligence/ranking/latest');
    expect(latestRes.body.cycleAt).toBe(newer.cycleAt);
    expect(latestRes.body.count).toBe(2);
    expect(latestRes.body.candidates.map((c: any) => c.symbol)).toEqual(['MSFT', 'AAPL']); // ordered by rank

    const historyRes = await request(app).get('/api/v2/continuous-intelligence/ranking/history/AAPL');
    expect(historyRes.body.count).toBe(2);
    expect(historyRes.body.history[0].cycleAt).toBe(newer.cycleAt); // newest first
  });
});
