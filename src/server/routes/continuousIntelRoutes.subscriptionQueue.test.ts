import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('/api/v2/continuous-intelligence/subscription-decisions and /capacity', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_subqueue_route_${Date.now()}_${process.pid}.db`);
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

  it('GET /subscription-decisions returns an empty list when nothing has been recorded', async () => {
    const res = await request(app).get('/api/v2/continuous-intelligence/subscription-decisions');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(0);
  });

  it('GET /subscription-decisions returns real PROMOTED/NOT_PROMOTED/EVICTED rows with reasons, newest first', async () => {
    await db.insert(schema.observabilityEvents).values({
      id: 'obs-sub-1', ts: 1000, level: 'INFO', category: 'DISCOVERY',
      eventType: 'SUBSCRIPTION_PROMOTED', loggerName: 'argus', message: 'subscription_priority_decision',
      sessionId: 'sess-1', symbol: 'AMD', payload: JSON.stringify({ reasoning: 'Beat weakest active dynamic symbol TSLA (0.10) by more than the hysteresis edge (0.05).' }),
    });
    await db.insert(schema.observabilityEvents).values({
      id: 'obs-sub-2', ts: 2000, level: 'INFO', category: 'DISCOVERY',
      eventType: 'SUBSCRIPTION_EVICTED', loggerName: 'argus', message: 'subscription_priority_decision',
      sessionId: 'sess-1', symbol: 'TSLA', payload: JSON.stringify({ reasoning: 'Lowest-ranked non-protected dynamic symbol (score=0.100, ticks=3) - evicted to stay within cap 90.' }),
    });

    const res = await request(app).get('/api/v2/continuous-intelligence/subscription-decisions');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.decisions[0].symbol).toBe('TSLA'); // newest first
    expect(res.body.decisions[0].action).toBe('EVICTED');
    expect(res.body.decisions[0].reason).toMatch(/lowest-ranked/i);
    expect(res.body.decisions[1].action).toBe('PROMOTED');
  });

  it('GET /capacity returns a real snapshot shape (values depend on live MarketDataWorker state)', async () => {
    const res = await request(app).get('/api/v2/continuous-intelligence/capacity');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.activeCount).toBe('number');
    expect(typeof res.body.effectiveCap).toBe('number');
    expect(typeof res.body.utilizationPct).toBe('number');
    expect(Array.isArray(res.body.activeSlots)).toBe(true);
  });
});
