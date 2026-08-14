import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

/**
 * Real integration test (isolated temp SQLite DB, real Express router via supertest) for
 * GET /api/v2/ai/token-consumption - the real replacement for Settings & Keys' Token Consumption
 * panel, previously a hardcoded mockTokenConsumptionData array with invented agent names. Proves
 * the route aggregates real ai_calls rows per real agent, correctly buckets local (cost:0) vs
 * paid calls, and computes an honest cost projection rather than a fabricated number.
 */
describe('GET /api/v2/ai/token-consumption', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_v2tokens_${Date.now()}_${process.pid}.db`);
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

  it('honestly reports available:false when no real AI calls have been logged', async () => {
    const res = await request(app).get('/api/v2/ai/token-consumption');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.available).toBe(false);
    expect(res.body.totals).toBeNull();
  });

  it('computes real per-agent token buckets and an honest cost projection from real ai_calls rows', async () => {
    const now = new Date().toISOString();
    await db.insert(schema.aiCalls).values([
      { id: 'c1', agent: 'NewsAgent', provider: 'Ollama (Local)', tokensIn: 100, tokensOut: 50, cost: 0, status: 'success', createdAt: now },
      { id: 'c2', agent: 'NewsAgent', provider: 'Gemini', tokensIn: 200, tokensOut: 100, cost: 0.01, status: 'success', createdAt: now },
      { id: 'c3', agent: 'FundamentalAgent', provider: 'Gemini', tokensIn: 300, tokensOut: 150, cost: 0.02, status: 'success', createdAt: now },
    ]);

    const res = await request(app).get('/api/v2/ai/token-consumption');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.available).toBe(true);

    const news = res.body.data.find((d: any) => d.agent === 'NewsAgent');
    expect(news.localTokens).toBe(150); // c1 only (cost:0)
    expect(news.paidTokens).toBe(300); // c2 only

    expect(res.body.totals.localTokens).toBe(150);
    expect(res.body.totals.paidTokens).toBe(750); // c2 (300) + c3 (450)
    expect(res.body.totals.totalCostLastNDays).toBe(0.03);
    // projection = (0.03 / 14) * 30, rounded to 2dp
    expect(res.body.totals.projectedCycleCost).toBeCloseTo(0.06, 2);
  });
});
