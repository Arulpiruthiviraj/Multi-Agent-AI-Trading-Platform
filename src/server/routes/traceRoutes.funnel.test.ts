import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Phase 4A (Decision Funnel, 2026-08-26) - GET /api/v2/traces/:traceId/funnel is a thin wrapper
 * around getFullDecisionFunnelTrace(), already covered thoroughly by queryTraces.test.ts. This
 * proves only the route's own contract: it's registered, calls that function, and returns its
 * result as JSON.
 */
describe('GET /api/v2/traces/:traceId/funnel', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_trace_funnel_route_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    const { traceRouter } = await import('./traceRoutes');
    app = express();
    app.use('/api/v2/traces', traceRouter);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('returns ok:true with an empty preIdeaStages array for an unknown traceId', async () => {
    const res = await request(app).get('/api/v2/traces/trace_UNKNOWN_0_0000/funnel');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.preIdeaStages).toEqual([]);
  });

  it('includes reconstructed pre-idea stages for a real traced idea', async () => {
    const traceId = 'trace_ROUTEFUNL_1800000000_beef';
    const ideaTs = 1_800_000_000_000;
    await db.insert(schema.transactionTraces).values({
      traceId, symbol: 'RTFN', createdAt: new Date(ideaTs).toISOString(), lifecycleStatus: 'ANALYZING',
    });
    await db.insert(schema.eventTraces).values({
      id: 'evt-route-scan', correlationId: null, timestamp: ideaTs - 60_000, source: 'OpportunityDiscovery',
      eventType: 'OPPORTUNITY_SCAN_COMPLETED',
      payload: JSON.stringify({ shortlist: [{ symbol: 'RTFN', assetClass: 'ETF', reason: 'already_subscribed' }] }),
    });
    await db.insert(schema.eventTraces).values({
      id: 'evt-route-idea', correlationId: traceId, timestamp: ideaTs, source: 'TechnicalAgent',
      eventType: 'TRADE_IDEA_GENERATED', payload: JSON.stringify({ symbol: 'RTFN', agent: 'TechnicalAgent' }),
    });

    const res = await request(app).get(`/api/v2/traces/${traceId}/funnel`);
    expect(res.status).toBe(200);
    expect(res.body.symbol).toBe('RTFN');
    const byStage = Object.fromEntries(res.body.preIdeaStages.map((s: any) => [s.stage, s]));
    expect(byStage.DISCOVERED.status).toBe('RECONSTRUCTED');
  });
});
