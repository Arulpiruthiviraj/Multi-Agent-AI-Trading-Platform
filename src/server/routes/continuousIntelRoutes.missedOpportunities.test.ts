import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('/api/v2/continuous-intelligence/missed-opportunities', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_missedopp_route_${Date.now()}_${process.pid}.db`);
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

  it('returns an empty list when nothing has been detected', async () => {
    const res = await request(app).get('/api/v2/continuous-intelligence/missed-opportunities');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(0);
    expect(res.body.byClassification).toEqual({});
  });

  it('returns persisted records with a classification breakdown, filtered by sinceMs', async () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 5000).toISOString();
    const old = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();

    await db.insert(schema.missedOpportunities).values([
      {
        id: 'miss-1', symbol: 'AAPL', detectedAt: recent, classification: 'SUBSCRIPTION_MISS',
        classificationReason: 'test', evidenceAtDecisionJson: '{}', priceAtDetection: 150,
        evaluationHorizonMinutes: 60, evaluationStatus: 'PENDING',
      },
      {
        id: 'miss-2', symbol: 'TSLA', detectedAt: recent, classification: 'EXECUTION_MISS',
        classificationReason: 'test', evidenceAtDecisionJson: '{}', priceAtDetection: 250,
        evaluationHorizonMinutes: 60, evaluationStatus: 'PENDING',
      },
      {
        id: 'miss-3', symbol: 'MSFT', detectedAt: old, classification: 'AGENT_MISS',
        classificationReason: 'test', evidenceAtDecisionJson: '{}', priceAtDetection: 300,
        evaluationHorizonMinutes: 60, evaluationStatus: 'PENDING',
      },
    ]);

    const res = await request(app).get('/api/v2/continuous-intelligence/missed-opportunities?sinceMs=60000');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.byClassification).toEqual({ SUBSCRIPTION_MISS: 1, EXECUTION_MISS: 1 });
    const symbols = res.body.rows.map((r: any) => r.symbol).sort();
    expect(symbols).toEqual(['AAPL', 'TSLA']);
  });
});
