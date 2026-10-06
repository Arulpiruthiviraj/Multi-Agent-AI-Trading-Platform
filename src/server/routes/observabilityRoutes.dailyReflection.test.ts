/**
 * Daily reflection route smoke tests (2026-10-06, workstream J, local-only).
 *
 * Thin wiring checks: the route exists, validates the date param, resolves
 * "latest", and delegates assembly to the service (which owns all DB reads).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

describe('GET /api/v2/observability/daily-reflection/:date', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_reflection_route_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb } = await import('../db'));
    const { observabilityRouter } = await import('./observabilityRoutes');
    app = express();
    app.use(express.json());
    app.use('/api/v2/observability', observabilityRouter);
  }, 60000);

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('returns the assembled report for a date with no rows (honest empty)', async () => {
    const res = await request(app).get('/api/v2/observability/daily-reflection/2099-01-01');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.report.tradingDate).toBe('2099-01-01');
    expect(res.body.report.hasData).toBe(false);
    expect(res.body.report.movers).toEqual([]);
  });

  it('resolves "latest" to the most recent completed session', async () => {
    const res = await request(app).get('/api/v2/observability/daily-reflection/latest');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.report.tradingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('400s on a malformed date', async () => {
    const res = await request(app).get('/api/v2/observability/daily-reflection/not-a-date');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});
