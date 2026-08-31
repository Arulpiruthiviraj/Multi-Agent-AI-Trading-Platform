import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

/**
 * Regression coverage for a real, live defect confirmed in data/logs/crash.log for Friday
 * 2026-08-28: two of the three unclean process deaths that day were directly preceded by
 * ERR_HTTP_HEADERS_SENT unhandledRejections at GET /api/v2/orchestration/models (v2System.ts, then
 * line 1736) and GET /api/v2/diagnostics (then line 1822) - real production crashes, real stack
 * traces, real timestamps matching the successor processes' own "did not shut down cleanly"
 * reports (PID 4820 died ~7s after the first; PID 13340 died via the DEF-25 storm circuit breaker
 * shortly after further such errors accumulated).
 *
 * Root cause: same class of bug already found and fixed once for GET /api/v2/orchestration/capital
 * (see v2System.orchestration.timeoutGuard.test.ts) - a slow/rejecting async call lets some other
 * layer (server.ts's global request backstop, or in production, whatever else responds first)
 * send a response before this handler's own catch block runs, and the catch block's unguarded
 * res.status(500).json(...) throws on the second write. This same unguarded pattern existed in
 * 49 other catch blocks across 9 route files (v2System.ts, analyticsRoutes.ts,
 * continuousIntelRoutes.ts, learningRoutes.ts, observabilityRoutes.ts, settingsEffectiveRoutes.ts,
 * systemRoutes.ts, traceRoutes.ts, v2Runtime.ts) - all given the identical `if (!res.headersSent)`
 * guard as this fix. Only the two PROVEN culprits get a dedicated regression test here; the rest
 * share the exact same one-line fix and are covered by the existing suite continuing to pass.
 */
describe('GET /api/v2/orchestration/models and /diagnostics - double-response guard (real Friday crash sites)', { timeout: 30000 }, () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let racedModelsApp: express.Express;
  let racedDiagnosticsApp: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_v2_headersguard_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    const { db } = await import('../db');
    sqliteDb = (await import('../db')).sqliteDb;
    const schema = await import('../db/schema');
    await db.insert(schema.settings).values({ budget: 100, maxTradeSize: 3000 });
    const { v2Router } = await import('./v2System');

    // Mirrors the real production race: something else (server.ts's global backstop, or - as
    // actually observed Friday - whatever responded first under real load) sends a response FIRST,
    // then this handler's own async work rejects and its catch block runs anyway.
    racedModelsApp = express();
    racedModelsApp.use('/api/v2/orchestration/models', (req, res, next) => {
      res.status(504).json({ error: 'Request Timeout (simulated race)' });
      next();
    });
    racedModelsApp.use('/api/v2', v2Router);

    racedDiagnosticsApp = express();
    racedDiagnosticsApp.use('/api/v2/diagnostics', (req, res, next) => {
      res.status(504).json({ error: 'Request Timeout (simulated race)' });
      next();
    });
    racedDiagnosticsApp.use('/api/v2', v2Router);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('GET /orchestration/models does not throw ERR_HTTP_HEADERS_SENT when a response was already sent before modelRuntimeManager.refresh() rejects', async () => {
    const { modelRuntimeManager } = await import('../ai/ModelRuntimeManager');
    const spy = vi.spyOn(modelRuntimeManager, 'refresh').mockRejectedValue(new Error('simulated real refresh failure'));

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      await request(racedModelsApp).get('/api/v2/orchestration/models');
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      spy.mockRestore();
    }

    const headersSentErrors = unhandledRejections.filter(
      (e) => e instanceof Error && e.message.includes('ERR_HTTP_HEADERS_SENT'),
    );
    expect(headersSentErrors).toEqual([]);
  });

  it('GET /diagnostics does not throw ERR_HTTP_HEADERS_SENT when a response was already sent before collectDiagnostics() rejects', async () => {
    const diagModule = await import('../diagnostics/DiagnosticService');
    const spy = vi.spyOn(diagModule, 'collectDiagnostics').mockRejectedValue(new Error('simulated real diagnostics failure'));

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      await request(racedDiagnosticsApp).get('/api/v2/diagnostics');
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      spy.mockRestore();
    }

    const headersSentErrors = unhandledRejections.filter(
      (e) => e instanceof Error && e.message.includes('ERR_HTTP_HEADERS_SENT'),
    );
    expect(headersSentErrors).toEqual([]);
  });
});
