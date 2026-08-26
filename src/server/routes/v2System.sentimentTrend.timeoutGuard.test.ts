import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

/**
 * Regression coverage for a real, live defect found in data/logs/crash.log (two
 * ERR_HTTP_HEADERS_SENT unhandledRejections on 2026-08-25 at 01:59:06Z/01:59:22Z, both pointing
 * at GET /api/v2/market/sentiment-trend's catch block): the route's db.select()/
 * historicalDataGateway.ensureBars() calls had no timeout of their own. A slow/hanging query
 * could keep the handler pending past server.ts's global 15s per-request backstop, which then
 * sends its own 504 first - this handler's eventual res.json()/res.status(500).json() threw on
 * the second write.
 *
 * Fixed the same way as GET /api/v2/orchestration/capital (see
 * v2System.orchestration.timeoutGuard.test.ts): bound the DB/gateway calls to 5s (well under the
 * 15s backstop) and guard every write in the handler with res.headersSent.
 */
const { hangingSelectBuilder } = vi.hoisted(() => {
  const builder: any = {
    from() { return builder; },
    where() { return new Promise(() => { /* never resolves */ }); },
  };
  return { hangingSelectBuilder: builder };
});

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return { ...actual, db: { ...actual.db, select: () => hangingSelectBuilder } };
});

describe('GET /api/v2/market/sentiment-trend (db.select() timeout + double-response guard)', { timeout: 30000 }, () => {
  let app: express.Express;
  let racedApp: express.Express;

  beforeAll(async () => {
    const { v2Router } = await import('./v2System');

    app = express();
    app.use('/api/v2', v2Router);

    // Mirrors server.ts's real global 15s per-request backstop: responds once, first, on the
    // exact same path, then calls next() so the real handler keeps running - reproducing "the
    // backstop already sent 504, then the slow handler finally rejects and tries to write again"
    // without waiting 15 real seconds in this test.
    racedApp = express();
    racedApp.use('/api/v2/market/sentiment-trend', (req, res, next) => {
      res.status(504).json({ error: 'Request Timeout (simulated backstop)' });
      next();
    });
    racedApp.use('/api/v2', v2Router);
  });

  afterAll(() => {
    delete process.env.ARGUS_DB_PATH;
  });

  it('does not hang forever when db.select() never resolves - bounded by the fallback timeout', async () => {
    const startedAt = Date.now();
    const res = await request(app).get('/api/v2/market/sentiment-trend');
    const elapsedMs = Date.now() - startedAt;

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    // The fix bounds db.select() to 5000ms; give generous slack for CI/test overhead while still
    // proving this is not an unbounded hang.
    expect(elapsedMs).toBeLessThan(10000);
  });

  it('does not throw ERR_HTTP_HEADERS_SENT when a response was already sent before db.select() rejects', async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      // racedApp's extra middleware sends the 504 first (simulating the global backstop), then
      // calls next() into the real handler, whose db.select() never resolves and will eventually
      // reject via this route's own 5s timeout.
      await request(racedApp).get('/api/v2/market/sentiment-trend');
      // Give the handler's post-timeout continuation a tick to run and (pre-fix) throw.
      await new Promise((r) => setTimeout(r, 6500));
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }

    const headersSentErrors = unhandledRejections.filter(
      (e) => e instanceof Error && e.message.includes('ERR_HTTP_HEADERS_SENT'),
    );
    expect(headersSentErrors).toEqual([]);
  }, 15000);
});
