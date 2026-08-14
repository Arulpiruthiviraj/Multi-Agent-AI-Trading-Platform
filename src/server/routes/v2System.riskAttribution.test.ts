import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

/**
 * Real integration test (isolated temp SQLite DB, real Express router via supertest) for
 * GET /api/v2/portfolio/risk-attribution - the real replacement for RiskAttributionTreemap.tsx's
 * fixed 5-entry array of invented per-agent risk percentages ("Macro Sentiment", "Order Flow",
 * "News Interpreter", "Risk Verifier" - none of which are real Argus agents, and static: no
 * fetch, ever updated). Proves the route computes real notional exposure per symbol from the
 * real portfolio table, grouped by the same sector map RiskEngine's own concentration gate uses.
 */
describe('GET /api/v2/portfolio/risk-attribution', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_v2riskattr_${Date.now()}_${process.pid}.db`);
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

  it('honestly reports available:false when the real portfolio holds no open positions', async () => {
    const res = await request(app).get('/api/v2/portfolio/risk-attribution');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.available).toBe(false);
    expect(res.body.data).toEqual([]);
  });

  it('computes real notional exposure per symbol, grouped by the real sector map, from real portfolio rows', async () => {
    const lastUpdated = new Date().toISOString();
    await db.insert(schema.portfolio).values([
      { symbol: 'AAPL', quantity: 10, averagePrice: 150, currentPrice: 200, lastUpdated }, // $2000, real Technology sector
      { symbol: 'MSFT', quantity: 5, averagePrice: 300, currentPrice: 400, lastUpdated }, // $2000, real Technology sector
      { symbol: 'ZZZZ_UNMAPPED', quantity: 100, averagePrice: 1, currentPrice: 1, lastUpdated }, // $100, no sector mapping
    ]);

    const res = await request(app).get('/api/v2/portfolio/risk-attribution');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.available).toBe(true);
    expect(res.body.totalValue).toBe(4100);

    const other = res.body.data.find((d: any) => d.sector === 'Other');
    expect(other).toBeTruthy();
    expect(other.symbols[0].symbol).toBe('ZZZZ_UNMAPPED');
    expect(other.value).toBe(100);

    const tech = res.body.data.find((d: any) => d.sector !== 'Other');
    expect(tech).toBeTruthy();
    expect(tech.value).toBe(4000);
    expect(tech.symbols.map((s: any) => s.symbol).sort()).toEqual(['AAPL', 'MSFT']);
  });
});
