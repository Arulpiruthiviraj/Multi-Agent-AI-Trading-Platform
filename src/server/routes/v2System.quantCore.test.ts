import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Real isolated-temp-SQLite-DB integration test (same established pattern as
 * CampaignTracker.test.ts) for the new /api/v2/quant-core/health and /api/v2/quant-core/parity
 * routes — the parity route's whole job is reading real rows back out of observability_events
 * (where QuantCoreBridge/ParityComparator actually persist divergences), so this proves the real
 * query/parse path, not a mocked one.
 */
describe('/api/v2/quant-core routes', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_quantcore_route_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    // Explicit 'false', not delete() - dotenv re-populates process.env from the real .env file
    // during a later import in this test run, which would silently override a deleted key back
    // to whatever the real .env currently has (that file's own QUANT_JAVA_CORE_ENABLED value is
    // an operator setting unrelated to this test and must not leak into it).
    process.env.QUANT_JAVA_CORE_ENABLED = 'false';

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
    delete process.env.QUANT_JAVA_CORE_ENABLED;
  });

  it('GET /quant-core/health reports disabled when QUANT_JAVA_CORE_ENABLED is not set', async () => {
    const res = await request(app).get('/api/v2/quant-core/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.enabled).toBe(false);
    expect(res.body.connected).toBe(false);
  });

  it('GET /quant-core/health reports the real liveIdeasEnabled state (Phase 3E dashboard) - false by default even if the base flag were on', async () => {
    const res = await request(app).get('/api/v2/quant-core/health');
    expect(res.status).toBe(200);
    // Neither QUANT_JAVA_CORE_ENABLED nor QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED is set in this test env.
    expect(res.body.liveIdeasEnabled).toBe(false);
  });

  it('GET /quant-core/parity returns an empty list when nothing has been recorded', async () => {
    const res = await request(app).get('/api/v2/quant-core/parity');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(0);
    expect(res.body.divergences).toEqual([]);
  });

  it('GET /quant-core/parity returns real rows persisted to observability_events, newest first', async () => {
    const older = {
      id: 'obs-1', ts: 1000, level: 'WARN', category: 'OBSERVABILITY',
      eventType: 'QUANT_CORE_PARITY_DIVERGENCE', loggerName: 'QuantCoreBridge',
      message: 'quant_core_parity_divergence', sessionId: 'sess-1', symbol: 'AAPL',
      payload: JSON.stringify({ divergences: [{ field: 'rsi', tsValue: 60, javaValue: 65, diffPct: 0.083 }] }),
    };
    const newer = {
      id: 'obs-2', ts: 2000, level: 'WARN', category: 'OBSERVABILITY',
      eventType: 'QUANT_CORE_PARITY_DIVERGENCE', loggerName: 'QuantCoreBridge',
      message: 'quant_core_parity_divergence', sessionId: 'sess-1', symbol: 'MSFT',
      payload: JSON.stringify({ divergences: [{ field: 'macd', tsValue: 1.2, javaValue: 1.0, diffPct: 0.167 }] }),
    };
    // Unrelated event type must never leak into this route's results.
    const unrelated = {
      id: 'obs-3', ts: 3000, level: 'INFO', category: 'SYSTEM',
      eventType: 'SOME_OTHER_EVENT', loggerName: 'Other', message: 'irrelevant', sessionId: 'sess-1',
    };
    await db.insert(schema.observabilityEvents).values(older);
    await db.insert(schema.observabilityEvents).values(newer);
    await db.insert(schema.observabilityEvents).values(unrelated);

    const res = await request(app).get('/api/v2/quant-core/parity');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.divergences[0].symbol).toBe('MSFT'); // newest first
    expect(res.body.divergences[0].divergences[0].field).toBe('macd');
    expect(res.body.divergences[1].symbol).toBe('AAPL');
  });
});
