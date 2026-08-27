import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Phase 3D (Confluence Center) — GET /api/v2/confluence/recent reads real
 * CONFLUENCE_COORDINATOR_TRIGGERED rows back out of observability_events (where
 * ConfluenceCoordinator.ts actually persists them via structuredLogger, not the EventBus — see
 * that module's own maybeTrigger()). Same isolated-temp-SQLite-DB pattern as
 * v2System.quantCore.test.ts.
 */
describe('/api/v2/confluence/recent', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_confluence_route_${Date.now()}_${process.pid}.db`);
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

  it('returns an empty list when nothing has been recorded', async () => {
    const res = await request(app).get('/api/v2/confluence/recent');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(0);
    expect(res.body.triggers).toEqual([]);
  });

  it('returns real rows persisted to observability_events, newest first, and never leaks unrelated event types', async () => {
    const older = {
      id: 'obs-conf-1', ts: 1000, level: 'INFO', category: 'CONSENSUS',
      eventType: 'CONFLUENCE_COORDINATOR_TRIGGERED', loggerName: 'ConfluenceCoordinator',
      message: 'confluence_coordinator_triggered', sessionId: 'sess-1', symbol: 'AAPL',
      traceId: 'trace-aapl-1',
      payload: JSON.stringify({ triggeredAgents: ['QuantEngine'], skippedAgents: ['KronosEngine:disabled'] }),
    };
    const newer = {
      id: 'obs-conf-2', ts: 2000, level: 'INFO', category: 'CONSENSUS',
      eventType: 'CONFLUENCE_COORDINATOR_TRIGGERED', loggerName: 'ConfluenceCoordinator',
      message: 'confluence_coordinator_triggered', sessionId: 'sess-1', symbol: 'MSFT',
      traceId: 'trace-msft-1',
      payload: JSON.stringify({ triggeredAgents: ['QuantEngine', 'KronosEngine'], skippedAgents: [] }),
    };
    const unrelated = {
      id: 'obs-conf-3', ts: 3000, level: 'WARN', category: 'OBSERVABILITY',
      eventType: 'QUANT_CORE_PARITY_DIVERGENCE', loggerName: 'QuantCoreBridge', message: 'irrelevant', sessionId: 'sess-1',
    };
    await db.insert(schema.observabilityEvents).values(older);
    await db.insert(schema.observabilityEvents).values(newer);
    await db.insert(schema.observabilityEvents).values(unrelated);

    const res = await request(app).get('/api/v2/confluence/recent');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.triggers[0].symbol).toBe('MSFT'); // newest first
    expect(res.body.triggers[0].triggeredAgents).toEqual(['QuantEngine', 'KronosEngine']);
    expect(res.body.triggers[1].symbol).toBe('AAPL');
    expect(res.body.triggers[1].skippedAgents).toEqual(['KronosEngine:disabled']);
  });

  it('respects the limit query param', async () => {
    const res = await request(app).get('/api/v2/confluence/recent?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.triggers.length).toBeLessThanOrEqual(1);
  });
});
