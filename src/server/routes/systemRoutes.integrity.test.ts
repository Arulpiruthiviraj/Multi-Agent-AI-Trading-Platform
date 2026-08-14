import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

/**
 * Real integration test for GET /api/v1/system/integrity - IntegrityValidator's real structural
 * checks (schema tables present, broker capabilities, AI/news providers seeded, local AI service
 * reachability, optional OpenAlice reachability). This route previously had no test coverage at
 * all; adding one now because the Validation tab (SystemValidationSuite.tsx) was just rewired to
 * depend on it as its real source of truth, replacing a fake `(Date.now() % 1000 / 1000) > 0.1`
 * RNG "test suite" - a regression here would now be a real, user-visible UI regression, not just
 * a backend one.
 */
describe('GET /api/v1/system/integrity', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_systemintegrity_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ sqliteDb } = await import('../db'));
    const { systemRouter } = await import('./systemRoutes');
    app = express();
    app.use(express.json());
    app.use('/api/v1', systemRouter);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('returns a real report shape with every declared schema table present in a fresh, fully-migrated DB', async () => {
    const res = await request(app).get('/api/v1/system/integrity');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.checks)).toBe(true);
    expect(res.body.checks.length).toBeGreaterThan(0);
    expect(typeof res.body.score).toBe('string');
    expect(typeof res.body.scorePct).toBe('number');

    const schemaCheck = res.body.checks.find((c: any) => c.id === 'schema_tables_exist');
    expect(schemaCheck).toBeTruthy();
    expect(schemaCheck.status).toBe('PASS');

    // Every check must be a real, honest status - never a fabricated value outside this vocabulary.
    for (const check of res.body.checks) {
      expect(['PASS', 'FAIL', 'UNKNOWN']).toContain(check.status);
      expect(typeof check.detail).toBe('string');
    }
  });
});
