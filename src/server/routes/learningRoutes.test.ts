import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('/api/v2/continuous-intelligence/learning/*', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_learningroutes_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    const { learningRouter } = await import('./learningRoutes');
    app = express();
    app.use('/api/v2/continuous-intelligence/learning', learningRouter);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('returns empty observations and a zeroed breakdown when nothing recorded', async () => {
    const res = await request(app).get('/api/v2/continuous-intelligence/learning/observations');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(0);
    expect(res.body.breakdown.executed).toBe(0);
    expect(res.body.breakdown.observational).toBe(0);
  });

  it('returns persisted observations with a real trust-level breakdown', async () => {
    const now = new Date().toISOString();
    await db.insert(schema.learningObservations).values([
      { id: 'o1', symbol: 'AAPL', observationType: 'CLOSED_TRADE', trustLevel: 'EXECUTED', evidenceJson: '{}', outcomeJson: '{}', createdAt: now },
      { id: 'o2', symbol: 'TSLA', observationType: 'REJECTED_CANDIDATE', trustLevel: 'OBSERVATIONAL', evidenceJson: '{}', outcomeJson: null, createdAt: now },
    ]);
    const res = await request(app).get('/api/v2/continuous-intelligence/learning/observations');
    expect(res.body.count).toBe(2);
    expect(res.body.breakdown.executed).toBe(1);
    expect(res.body.breakdown.observational).toBe(1);
  });

  it('returns version history with the correct championId', async () => {
    const now = new Date().toISOString();
    await db.insert(schema.learningVersions).values([
      { id: 'v1', versionType: 'agent-weighting', status: 'CHAMPION', stateJson: '{}', sampleSize: 25, createdAt: now, promotedAt: now },
      { id: 'v2', versionType: 'agent-weighting', status: 'SHADOW', stateJson: '{}', sampleSize: 0, createdAt: now },
    ]);
    const res = await request(app).get('/api/v2/continuous-intelligence/learning/versions/agent-weighting');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.championId).toBe('v1');
  });

  it('returns promotion history for a version', async () => {
    const now = new Date().toISOString();
    await db.insert(schema.promotionDecisions).values([
      { versionId: 'v1', decision: 'PASS', reason: 'test', metricsJson: '{}', decidedAt: now },
    ]);
    const res = await request(app).get('/api/v2/continuous-intelligence/learning/versions/agent-weighting/v1/promotions');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.history[0].decision).toBe('PASS');
  });

  it('returns real calibration candidates (empty when no calibration rows exist)', async () => {
    const res = await request(app).get('/api/v2/continuous-intelligence/learning/calibration/candidates');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(0);
    expect(res.body.candidates).toEqual([]);
  });

  it('returns calibration worker status without throwing when the worker has never run', async () => {
    const res = await request(app).get('/api/v2/continuous-intelligence/learning/calibration/worker-status');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.running).toBe(false);
  });

  it('returns rollback history for a versionType', async () => {
    const now = new Date().toISOString();
    await db.insert(schema.rollbackEvents).values([
      { versionType: 'agent-weighting', fromVersionId: 'v2', toVersionId: 'v1', reason: 'test', actor: 'operator', createdAt: now },
    ]);
    const res = await request(app).get('/api/v2/continuous-intelligence/learning/versions/agent-weighting/rollbacks');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.history[0].toVersionId).toBe('v1');
  });
});
