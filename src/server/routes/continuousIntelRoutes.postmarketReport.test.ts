import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('/api/v2/continuous-intelligence/postmarket-report (Phase 2, 2026-09-10)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let mod: typeof import('../continuous/PostMarketAnalysis');
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_postmarket_route_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ sqliteDb } = await import('../db'));
    mod = await import('../continuous/PostMarketAnalysis');
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

  it('returns 404 (not a crash) when no report has been persisted for the requested date', async () => {
    const res = await request(app).get('/api/v2/continuous-intelligence/postmarket-report/2099-01-01');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  it('returns a real, persisted report for an explicit date', async () => {
    const report = await mod.generatePostMarketReport('2026-09-10');
    await mod.persistPostMarketReport(report);

    const res = await request(app).get('/api/v2/continuous-intelligence/postmarket-report/2026-09-10');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.report.tradingDate).toBe('2026-09-10');
    expect(res.body.report.flowScorecard).toBeDefined();
  });

  it('the rollup route returns a real, well-formed rollup even with only one persisted day', async () => {
    const res = await request(app).get('/api/v2/continuous-intelligence/postmarket-rollup?days=30');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.rollup.daysConsidered).toContain('2026-09-10');
    expect(res.body.rollup.recurringBlindSpots).toEqual([]); // only 1 day persisted by this point - nothing can be "recurring" yet
  });
});
