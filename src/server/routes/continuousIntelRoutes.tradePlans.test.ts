import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('/api/v2/continuous-intelligence/trade-plans/*', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_tradeplan_route_${Date.now()}_${process.pid}.db`);
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

  it('returns an empty list for a date with no plans', async () => {
    const res = await request(app).get('/api/v2/continuous-intelligence/trade-plans/2026-08-27');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(0);
  });

  it('returns real plans with parsed catalysts/components, and revalidation history for one plan', async () => {
    await db.insert(schema.tradePlans).values({
      id: 'plan-1', symbol: 'AAPL', planDate: '2026-08-27', setupType: 'PRIMARY', direction: 'BUY',
      thesis: 'test thesis', catalysts: JSON.stringify(['News catalyst']),
      entryZoneLow: 99, entryZoneHigh: 101, invalidationLevel: 95, targetConcept: 'test',
      confidence: 0.8, evidenceQuality: 0.7, rankAtCreation: 1,
      componentScoresJson: JSON.stringify({ momentum: { score: 0.8, available: true } }),
      status: 'READY', createdAt: new Date().toISOString(), validUntil: new Date().toISOString(),
    });
    await db.insert(schema.tradePlanRevalidations).values({
      planId: 'plan-1', revalidatedAt: new Date().toISOString(), result: 'REVALIDATED', reason: 'still valid', priceAtRevalidation: 100,
    });

    const plansRes = await request(app).get('/api/v2/continuous-intelligence/trade-plans/2026-08-27');
    expect(plansRes.body.count).toBe(1);
    expect(plansRes.body.plans[0].catalysts).toEqual(['News catalyst']);
    expect(plansRes.body.plans[0].components.momentum.score).toBe(0.8);
    expect(plansRes.body.plans[0].componentScoresJson).toBeUndefined();

    const historyRes = await request(app).get('/api/v2/continuous-intelligence/trade-plans/2026-08-27/plan-1/revalidations');
    expect(historyRes.body.count).toBe(1);
    expect(historyRes.body.history[0].result).toBe('REVALIDATED');
  });
});
