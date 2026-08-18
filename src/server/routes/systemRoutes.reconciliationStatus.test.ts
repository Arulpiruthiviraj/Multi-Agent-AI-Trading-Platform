import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

describe('GET /api/v1/system/reconciliation/status', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_recon_status_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb } = await import('../db'));
    const { systemRouter } = await import('./systemRoutes');
    app = express();
    app.use(express.json());
    app.use('/api/v1', systemRouter);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('is read-only evidence: tradingState plus latest recon, and does not resume', async () => {
    const res = await request(app).get('/api/v1/system/reconciliation/status');
    expect(res.status).toBe(200);
    expect(res.body.note).toMatch(/does not change tradingState/i);
    expect(res.body).toHaveProperty('tradingState');
    expect(res.body).toHaveProperty('unackedFilledOrphans');
    expect(res.body).toHaveProperty('acknowledgements');
    expect(Array.isArray(res.body.unackedFilledOrphans)).toBe(true);
    const before = res.body.tradingState;
    const again = await request(app).get('/api/v1/system/reconciliation/status');
    expect(again.body.tradingState).toBe(before);
  });
});
