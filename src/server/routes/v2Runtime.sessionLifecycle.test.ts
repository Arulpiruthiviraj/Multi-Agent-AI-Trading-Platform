import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Phase 4J (Session Lifecycle persistence): GET /api/v2/runtime/session-lifecycle surfaces the
 * live in-process snapshot plus recently persisted history - isolated temp DB since this reads
 * from session_lifecycle_snapshots, same pattern as v2Runtime.riskAssessments.test.ts.
 */
describe('/api/v2/runtime/session-lifecycle', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_session_lifecycle_route_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    const { runtimeRouter } = await import('./v2Runtime');

    app = express();
    app.use('/api/v2/runtime', runtimeRouter);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('returns a current snapshot and an empty history when nothing persisted yet', async () => {
    const res = await request(app).get('/api/v2/runtime/session-lifecycle');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.current).toHaveProperty('marketSession');
    expect(res.body.current).toHaveProperty('appState');
    expect(res.body.history).toEqual([]);
  });

  it('returns persisted history rows, most recent first', async () => {
    await db.insert(schema.sessionLifecycleSnapshots).values([
      { tradingDate: '2026-08-26', marketSession: 'PRE_MARKET', appState: 'RESEARCHING', premarketFiredForDate: '2026-08-26', evaluatedAt: '2026-08-26T08:00:00.000Z', createdAt: '2026-08-26T08:00:00.000Z' },
      { tradingDate: '2026-08-26', marketSession: 'REGULAR', appState: 'INTRADAY', premarketFiredForDate: '2026-08-26', evaluatedAt: '2026-08-26T10:00:00.000Z', createdAt: '2026-08-26T10:00:00.000Z' },
    ]);
    const res = await request(app).get('/api/v2/runtime/session-lifecycle?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.history.length).toBe(2);
    expect(res.body.history[0].marketSession).toBe('REGULAR');
    expect(res.body.history[1].marketSession).toBe('PRE_MARKET');
  });
});
