import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Phase 4B (Evidence-Aware Consensus, SHADOW MODE ONLY): GET /api/v2/consensus/shadow-comparison
 * reads real CONSENSUS_MODEL_COMPARISON rows back out of observability_events (where
 * ChiefTraderAgent.ts persists them via ConsensusModelComparison.ts, never the EventBus). Same
 * isolated-temp-SQLite-DB pattern as v2System.quantCore.test.ts / v2System.confluence.test.ts.
 */
describe('/api/v2/consensus/shadow-comparison', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_consensus_shadow_route_${Date.now()}_${process.pid}.db`);
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
    const res = await request(app).get('/api/v2/consensus/shadow-comparison');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(0);
    expect(res.body.agreementRate).toBeNull();
  });

  it('returns real rows persisted to observability_events, newest first, with agreement stats', async () => {
    const agree = {
      id: 'obs-shadow-1', ts: 1000, level: 'INFO', category: 'CONSENSUS',
      eventType: 'CONSENSUS_MODEL_COMPARISON', loggerName: 'ChiefTraderAgent',
      message: 'consensus_model_comparison', sessionId: 'sess-1', symbol: 'AAPL', traceId: 'trace-1',
      payload: JSON.stringify({
        legacyDecision: 'HOLD', legacyApproved: false, legacyConfidence: 0.3,
        shadowDecision: 'HOLD', shadowApproved: false, shadowConfidence: 0.3,
        bullishEvidence: 0.3, bearishEvidence: 0.1, uncertainty: 0.6, excludedAgents: [], reasonCode: 'INSUFFICIENT_CONVICTION', agree: true,
      }),
    };
    const disagree = {
      id: 'obs-shadow-2', ts: 2000, level: 'INFO', category: 'CONSENSUS',
      eventType: 'CONSENSUS_MODEL_COMPARISON', loggerName: 'ChiefTraderAgent',
      message: 'consensus_model_comparison', sessionId: 'sess-1', symbol: 'NVDA', traceId: 'trace-2',
      payload: JSON.stringify({
        legacyDecision: 'HOLD', legacyApproved: false, legacyConfidence: 0.17,
        shadowDecision: 'BUY', shadowApproved: true, shadowConfidence: 0.8,
        bullishEvidence: 0.8, bearishEvidence: 0, uncertainty: 0.1,
        excludedAgents: [{ agent: 'FundamentalAgent', reason: 'DATA_UNAVAILABLE_CALIBRATION_OVERRIDE_IGNORED' }],
        reasonCode: 'BULLISH_EVIDENCE_CLEARS_THRESHOLD', agree: false,
      }),
    };
    await db.insert(schema.observabilityEvents).values(agree);
    await db.insert(schema.observabilityEvents).values(disagree);

    const res = await request(app).get('/api/v2/consensus/shadow-comparison');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.comparisons[0].symbol).toBe('NVDA'); // newest first
    expect(res.body.comparisons[0].shadowDecision).toBe('BUY');
    expect(res.body.comparisons[0].excludedAgents).toHaveLength(1);
    expect(res.body.agreeCount).toBe(1);
    expect(res.body.disagreeCount).toBe(1);
    expect(res.body.agreementRate).toBe(0.5);
  });
});
