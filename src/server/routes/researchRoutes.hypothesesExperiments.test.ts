import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import { Router } from 'express';
import request from 'supertest';

/**
 * 2026-09-11 (Research Memory Platform Phase 1). Real integration test (isolated temp SQLite DB,
 * real Express router via supertest, real experimentLedger.ts DB functions - no mocks) for the new
 * read-only GET /api/v2/research/hypotheses, /research/experiments, /research/experiments/:id
 * routes, distinct from the pre-existing in-memory-only /research/experiment-ledger.
 */
describe('GET /api/v2/research/hypotheses and /research/experiments', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let app: express.Express;
  let ledgerMod: typeof import('../research/experimentLedger');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_research_routes_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ sqliteDb } = await import('../db'));
    ledgerMod = await import('../research/experimentLedger');

    const { mountResearchRoutes } = await import('./researchRoutes');
    app = express();
    app.use(express.json());
    const v2Router = Router();
    mountResearchRoutes(v2Router);
    app.use('/api/v2', v2Router);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('GET /research/hypotheses returns an empty list before any are registered, then the real registered row', async () => {
    const before = await request(app).get('/api/v2/research/hypotheses').query({ strategyId: 'ROUTE_TEST_STRATEGY' });
    expect(before.status).toBe(200);
    expect(before.body.ok).toBe(true);
    expect(before.body.hypotheses).toEqual([]);

    await ledgerMod.registerHypothesis({ statement: 'Route-test hypothesis.', strategyId: 'ROUTE_TEST_STRATEGY' });

    const after = await request(app).get('/api/v2/research/hypotheses').query({ strategyId: 'ROUTE_TEST_STRATEGY' });
    expect(after.status).toBe(200);
    expect(after.body.hypotheses.length).toBe(1);
    expect(after.body.hypotheses[0].statement).toBe('Route-test hypothesis.');
    expect(after.body.hypotheses[0].resolvedAt).toBeNull();
  });

  it('GET /research/experiments/:id returns 404 for an unknown id, and the real composed shape once created', async () => {
    const notFound = await request(app).get('/api/v2/research/experiments/does-not-exist');
    expect(notFound.status).toBe(404);
    expect(notFound.body.ok).toBe(false);

    const experimentId = await ledgerMod.createExperiment({ strategyId: 'ROUTE_TEST_STRATEGY', label: 'Route test experiment' });
    const found = await request(app).get(`/api/v2/research/experiments/${experimentId}`);
    expect(found.status).toBe(200);
    expect(found.body.ok).toBe(true);
    expect(found.body.experiment.label).toBe('Route test experiment');
    expect(found.body.trials).toEqual([]);

    const list = await request(app).get('/api/v2/research/experiments').query({ strategyId: 'ROUTE_TEST_STRATEGY' });
    expect(list.status).toBe(200);
    expect(list.body.experiments.some((e: any) => e.id === experimentId)).toBe(true);
  });
});
