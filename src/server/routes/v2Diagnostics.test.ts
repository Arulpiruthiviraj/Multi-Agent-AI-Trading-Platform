/**
 * Tests for GET /api/v2/diagnostics/quant-readiness (2026-10-08 code-only defect repair).
 *
 * Proves the production-state diagnostic uses the REAL resolver against a REAL DB:
 * - empty learning_versions -> every strategy is NOT_AUTHORIZED/NO_LIFECYCLE_RECORD
 *   (the defect #1 production state, now visible instead of silently defaulting)
 * - a recorded VALIDATED row -> AUTHORIZED_QUANT_POLICY for that strategy only
 * - a recorded RETIRED row -> NOT_ELIGIBLE
 * - the report is read-only: building it must not create any lifecycle rows
 *   (assert the learning_versions row count is unchanged afterwards)
 *
 * Isolation: ARGUS_DB_PATH points at a temp SQLite file; migrations run on import
 * (same pattern as continuousIntelRoutes.missedOpportunities.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('GET /api/v2/diagnostics/quant-readiness', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let app: express.Express;
  let prevPaperOnly: string | undefined;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_quantreadiness_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    prevPaperOnly = process.env.PAPER_TRADING_ONLY;
    process.env.PAPER_TRADING_ONLY = 'true';

    ({ sqliteDb } = await import('../db'));
    const { diagnosticsRouter } = await import('./v2Diagnostics');
    app = express();
    app.use('/api/v2/diagnostics', diagnosticsRouter);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
    if (prevPaperOnly === undefined) delete process.env.PAPER_TRADING_ONLY;
    else process.env.PAPER_TRADING_ONLY = prevPaperOnly;
  });

  function learningVersionCount(): number {
    const row = sqliteDb.prepare(
      "SELECT COUNT(*) AS n FROM learning_versions WHERE version_type LIKE 'strategyEligibility:%'",
    ).get() as { n: number };
    return row.n;
  }

  it('reports NOT_AUTHORIZED/NO_LIFECYCLE_RECORD for every strategy when the DB has no lifecycle rows', async () => {
    const res = await request(app).get('/api/v2/diagnostics/quant-readiness');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.readOnly).toBe(true);
    expect(res.body.paperOnlyEnforced).toBe(true);
    expect(res.body.strategies.length).toBeGreaterThan(0);
    for (const s of res.body.strategies) {
      expect(s.lifecycleRecordExists).toBe(false);
      expect(s.lifecycleStatus).toBeNull();
      expect(s.authority).toBe('NOT_AUTHORIZED');
      expect(s.reason).toBe('NO_LIFECYCLE_RECORD');
      expect(s.quantPolicyEligible).toBe(false);
    }
    expect(res.body.summary.notAuthorizedMissingLifecycle).toBe(res.body.summary.total);
    expect(res.body.summary.authorizedQuantPolicy).toBe(0);
  });

  it('reflects recorded lifecycle decisions and never writes any itself', async () => {
    const { recordStrategyLifecycleTransition } = await import(
      '../quant/strategies/StrategyEmissionEligibility'
    );
    const { CORE_STRATEGIES } = await import('../quant/strategies/StrategyEngine');
    const validatedId = CORE_STRATEGIES[0].id;
    const retiredId = CORE_STRATEGIES[1].id;

    await recordStrategyLifecycleTransition(validatedId, 'VALIDATED', 'test hypothesis', null, 100);
    await recordStrategyLifecycleTransition(retiredId, 'RETIRED', 'test hypothesis', null, 100);
    const rowsBefore = learningVersionCount();
    expect(rowsBefore).toBe(2);

    const res = await request(app).get('/api/v2/diagnostics/quant-readiness');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.strategies.map((s: any) => [s.strategyId, s]));

    expect(byId[validatedId].lifecycleRecordExists).toBe(true);
    expect(byId[validatedId].lifecycleStatus).toBe('VALIDATED');
    expect(byId[validatedId].authority).toBe('AUTHORIZED_QUANT_POLICY');
    expect(byId[validatedId].reason).toBe('STRATEGY_VALIDATED');
    expect(byId[validatedId].quantPolicyEligible).toBe(true);

    expect(byId[retiredId].authority).toBe('NOT_ELIGIBLE');
    expect(byId[retiredId].reason).toBe('STRATEGY_RETIRED');

    expect(res.body.summary.authorizedQuantPolicy).toBe(1);
    expect(res.body.summary.notEligible).toBe(1);
    expect(res.body.summary.quantPolicyEligibleIds).toEqual([validatedId]);

    // Read-only proof: the diagnostic created no lifecycle rows of its own.
    expect(learningVersionCount()).toBe(rowsBefore);
  });

  it('summary counts are consistent with the per-strategy rows', async () => {
    const res = await request(app).get('/api/v2/diagnostics/quant-readiness');
    expect(res.status).toBe(200);
    const s = res.body.summary;
    expect(s.total).toBe(res.body.strategies.length);
    expect(
      s.authorizedQuantPolicy + s.requiresConsensus + s.notEligible + s.notAuthorizedMissingLifecycle,
    ).toBe(s.total);
    expect(s.quantPolicyEligibleIds.length).toBe(s.authorizedQuantPolicy);
  });
});
