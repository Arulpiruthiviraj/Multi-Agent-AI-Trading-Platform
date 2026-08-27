import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import express from 'express';

/**
 * Phase 3C (Candidate Ranking dashboard): GET /api/v2/continuous-intelligence/status must forward
 * the full per-symbol score breakdown SnapshotScanner.ts already computes (symbol, momentumScore,
 * intradayPctChange, relativeVolume) in `lastScan.top`, not just bare symbol names (`topMovers`,
 * which discarded everything else). Discovery score only — this route/module never imports
 * OMS/RiskEngine/BrokerManager and never determines order eligibility.
 */
describe('/api/v2/continuous-intelligence/status', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { continuousIntelRouter } = await import('./continuousIntelRoutes');
    app = express();
    app.use('/api/v2/continuous-intelligence', continuousIntelRouter);
  });

  it('responds ok and includes a lastScan.top array shaped like SnapshotScanStats.top', async () => {
    const res = await request(app).get('/api/v2/continuous-intelligence/status');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.lastScan.top)).toBe(true);
    expect(Array.isArray(res.body.lastScan.topMovers)).toBe(true);
    // Before any real scan cycle has run in this test process, both are legitimately empty —
    // this test only proves the field's presence/shape contract, not live scan content.
    if (res.body.lastScan.top.length > 0) {
      const row = res.body.lastScan.top[0];
      expect(typeof row.symbol).toBe('string');
      expect(typeof row.momentumScore).toBe('number');
      expect(typeof row.intradayPctChange).toBe('number');
      expect(typeof row.relativeVolume).toBe('number');
    }
  });
});
