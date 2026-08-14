import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

/**
 * Real integration test (isolated temp SQLite DB, real Express router via supertest) for
 * GET /api/v2/opportunities - the real replacement for the Opportunity Feed tab's 3 hardcoded
 * NVDA/TSLA/RIVN cards (invented "Regime"/"Algorithm" fields, a "LIVE SCAN ACTIVE" badge with no
 * fetch behind it). Proves the route surfaces real, recent, high-confidence, non-HOLD
 * agent_predictions and honestly reports unavailable when nothing clears the confidence floor.
 */
describe('GET /api/v2/opportunities', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_v2opps_${Date.now()}_${process.pid}.db`);
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

  it('honestly reports available:false when nothing clears the real confidence floor', async () => {
    const now = new Date().toISOString();
    await db.insert(schema.agentPredictions).values([
      { id: 'low-1', agentName: 'TechnicalAgent', symbol: 'AAPL', prediction: 'BUY', confidence: 0.5, reasoning: 'weak', timestamp: now },
      { id: 'hold-1', agentName: 'NewsAgent', symbol: 'MSFT', prediction: 'HOLD', confidence: 0.9, reasoning: 'no signal', timestamp: now },
    ]);
    const res = await request(app).get('/api/v2/opportunities');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.available).toBe(false);
    expect(res.body.data).toEqual([]);
  });

  it('surfaces real, recent, high-confidence, non-HOLD predictions from real agents only, sorted by confidence', async () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // outside the 24h window
    await db.insert(schema.agentPredictions).values([
      { id: 'good-1', agentName: 'TechnicalAgent', symbol: 'NVDA', prediction: 'BUY', confidence: 0.87, reasoning: 'real RSI breakout', timestamp: now },
      { id: 'good-2', agentName: 'MacroAgent', symbol: 'TSLA', prediction: 'SELL', confidence: 0.72, reasoning: 'real macro deterioration', timestamp: now },
      { id: 'too-old', agentName: 'NewsAgent', symbol: 'AMD', prediction: 'BUY', confidence: 0.95, reasoning: 'stale', timestamp: old },
      { id: 'not-real-agent', agentName: 'SentimentAgent', symbol: 'RIVN', prediction: 'BUY', confidence: 0.99, reasoning: 'not a real agent', timestamp: now },
    ]);

    const res = await request(app).get('/api/v2/opportunities');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.available).toBe(true);
    expect(res.body.data.map((d: any) => d.symbol)).toEqual(['NVDA', 'TSLA']); // sorted by confidence desc, stale/non-real-agent excluded
    expect(res.body.data[0].confidence).toBe(87);
    expect(res.body.data[0].agent).toBe('TechnicalAgent');
  });
});
