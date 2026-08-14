import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

/**
 * Real integration test (isolated temp SQLite DB, real Express router via supertest) for
 * GET /api/v2/portfolio/stress-test - the real replacement for Holdings & Positions' Stress
 * Testing panel, which previously produced identical "Affected Sectors"/"Guardrail Action Plan"
 * output regardless of which of the 4 scenario buttons was clicked. This is a real what-if
 * calculator: the caller supplies the shock assumption explicitly (never a value Argus invents
 * per named scenario), and every other number is computed from real portfolio/settings rows.
 */
describe('GET /api/v2/portfolio/stress-test', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_v2stress_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');

    const { v2Router } = await import('./v2System');
    app = express();
    app.use(express.json());
    app.use('/api/v2', v2Router);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('rejects a positive or out-of-range shockPct rather than silently coercing it', async () => {
    const res1 = await request(app).get('/api/v2/portfolio/stress-test?shockPct=10');
    expect(res1.status).toBe(400);
    const res2 = await request(app).get('/api/v2/portfolio/stress-test?shockPct=-150');
    expect(res2.status).toBe(400);
  });

  it('honestly reports available:false when the real portfolio holds no open positions', async () => {
    const res = await request(app).get('/api/v2/portfolio/stress-test?shockPct=-10');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.available).toBe(false);
  });

  it('computes a real projected loss from real positions and honestly reports no drawdown-gate baseline when peakEquity is unset', async () => {
    const lastUpdated = new Date().toISOString();
    await db.insert(schema.portfolio).values([
      { symbol: 'AAPL', quantity: 10, averagePrice: 150, currentPrice: 200, lastUpdated },
    ]);

    const res = await request(app).get('/api/v2/portfolio/stress-test?shockPct=-10');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.available).toBe(true);
    expect(res.body.data.totalValue).toBe(2000);
    expect(res.body.data.projectedLoss).toBe(-200);
    expect(res.body.data.projectedValue).toBe(1800);
    expect(res.body.data.affectedSectors.length).toBeGreaterThan(0);
    expect(res.body.data.wouldTripDrawdownGate).toBeNull(); // no real settings row -> no peakEquity yet
  });

  it('correctly evaluates the real portfolio_drawdown gate threshold once a real peakEquity baseline exists', async () => {
    await db.insert(schema.settings).values({ peakEquity: 2000, maxPortfolioDrawdownPct: 0.05 });

    const res = await request(app).get('/api/v2/portfolio/stress-test?shockPct=-10');
    expect(res.status).toBe(200);
    // projectedValue 1800 vs peak 2000 -> 10% drawdown, which is >= the real 5% configured limit
    expect(res.body.data.wouldTripDrawdownGate).toBe(true);
  });
});
