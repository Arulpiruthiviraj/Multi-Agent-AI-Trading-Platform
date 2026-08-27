import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Phase 3F (Risk Center): GET /api/v2/runtime/risk/recent-assessments must surface the real
 * per-gate breakdown from risk_gate_results (every gate recorded even after the first failure,
 * per CLAUDE.md's own invariant) joined to its risk_assessments row - never a synthesized pass.
 * Isolated temp SQLite DB (same pattern as v2System.quantCore.test.ts) since this inserts rows,
 * unlike v2Runtime.test.ts's existing read-only-against-default-db tests.
 */
describe('/api/v2/runtime/risk/recent-assessments', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_risk_recent_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    const { runtimeRouter } = await import('./v2Runtime');

    app = express();
    app.use('/api/v2/runtime', runtimeRouter);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('returns an empty list when nothing has been recorded', async () => {
    const res = await request(app).get('/api/v2/runtime/risk/recent-assessments');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(0);
    expect(res.body.assessments).toEqual([]);
  });

  it('joins real risk_gate_results rows to their risk_assessments row, including gates recorded after the first failure', async () => {
    await db.insert(schema.riskAssessments).values({
      traceId: 'trace_risktest_1',
      symbol: 'AAPL',
      side: 'BUY',
      approved: false,
      maxQuantity: 0,
      rejectionGate: 'daily_loss',
      accountEquity: 100000,
      buyingPower: 50000,
      reasoning: 'test',
      createdAt: new Date(1000).toISOString(),
    });
    await db.insert(schema.riskGateResults).values([
      { traceId: 'trace_risktest_1', gateName: 'emergency_stop', sequence: 1, passed: true, detail: null },
      { traceId: 'trace_risktest_1', gateName: 'daily_loss', sequence: 8, passed: false, detail: JSON.stringify({ dailyLoss: 900, limit: 1000 }) },
      // Recorded even though the first failure (daily_loss) already determined the reject —
      // proves this route does not stop at the first failing gate.
      { traceId: 'trace_risktest_1', gateName: 'price_validity', sequence: 15, passed: true, detail: null },
    ]);

    const res = await request(app).get('/api/v2/runtime/risk/recent-assessments');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    const a = res.body.assessments[0];
    expect(a.traceId).toBe('trace_risktest_1');
    expect(a.approved).toBe(false);
    expect(a.rejectionGate).toBe('daily_loss');
    expect(a.gates).toHaveLength(3);
    expect(a.gates.map((g: any) => g.gateName)).toEqual(['emergency_stop', 'daily_loss', 'price_validity']);
    expect(a.gates[1].passed).toBe(false);
  });

  it('respects the limit query param', async () => {
    const res = await request(app).get('/api/v2/runtime/risk/recent-assessments?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.assessments.length).toBeLessThanOrEqual(1);
  });
});
