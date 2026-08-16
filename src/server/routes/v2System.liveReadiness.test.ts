import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

describe('GET /api/v2/live-readiness', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_live_ready_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.OPENALICE_ENABLED = 'false';
    ({ sqliteDb } = await import('../db'));
    const { v2Router } = await import('./v2System');
    app = express();
    app.use(express.json());
    app.use('/api/v2', v2Router);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('returns LIVE_NO_GO with edge score and never 404', async () => {
    const res = await request(app).get('/api/v2/live-readiness');
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('LIVE_NO_GO');
    expect(res.body.live).toBe('NO-GO');
    expect(res.body.tradingEdgeScore).toBe(8);
    expect(res.body.organicPaper).toBe('NOT_ESTABLISHED');
    expect(res.body.canPlaceOrdersViaResearch).toBe(false);
    expect(Array.isArray(res.body.failedMandatory)).toBe(true);
    expect(res.body.failedMandatory.length).toBeGreaterThan(0);
  });

  it('GET /research/replay/providers lists providers and never 404', async () => {
    const res = await request(app).get('/api/v2/research/replay/providers');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.live).toBe('NO-GO');
    expect(res.body.canPlaceOrders).toBe(false);
    expect(Array.isArray(res.body.providers)).toBe(true);
    expect(res.body.providers.length).toBeGreaterThan(0);
    expect(res.body.providers.some((p: { id: string }) => p.id === 'golden_replay')).toBe(true);
  });

  it('POST /research/replay/create is registered (never Express catch-all 404)', async () => {
    const res = await request(app)
      .post('/api/v2/research/replay/create')
      .send({
        symbols: ['AAPL'],
        strategyIds: ['MOMENTUM_BREAKOUT'],
        dataProvider: 'golden_replay',
        frequency: '1Day',
        startDate: '2024-01-02',
        endDate: '2024-06-28',
        initialCapital: 100000,
        allocationBudget: 3000,
        aiMode: 'DISABLED',
      });
    // Handler may return 200 ok or 400 DATA_UNAVAILABLE — never the catch-all 404 string.
    expect(res.status).not.toBe(404);
    expect(String(res.body?.error || '')).not.toMatch(/API route not found/i);
    expect(res.body.canPlaceOrders === false || res.body.ok === true || res.body.ok === false).toBe(true);
  });
});
