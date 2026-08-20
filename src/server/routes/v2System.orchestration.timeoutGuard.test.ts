import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

/**
 * Regression coverage for a real, live defect found in data/logs/crash.log (repeated
 * ERR_HTTP_HEADERS_SENT unhandledRejections at this exact call site through 2026-08-20, while
 * running the real engine against Alpaca paper): GET /api/v2/orchestration/capital's
 * broker.portfolio()/broker.orders() calls had no timeout of their own. A slow/degraded broker
 * call could keep this handler pending past server.ts's global 15s per-request backstop, which
 * then sends its own 504 first - this handler's eventual res.json() threw on the second write.
 *
 * Fixed the same way as GET /api/v1/pnl/analytics and GET /api/v1/portfolio: bound both broker
 * calls to 5s (well under the 15s backstop) and guard every write in the handler with
 * res.headersSent.
 */
const { mockBroker } = vi.hoisted(() => ({
  mockBroker: {
    portfolio: vi.fn(() => new Promise(() => { /* never resolves */ })),
    orders: vi.fn(async () => []),
  },
}));

vi.mock('../../brokers/BrokerManager', () => ({
  BrokerManager: { getInstance: () => ({ getActiveBroker: () => mockBroker }) },
}));

describe('GET /api/v2/orchestration/capital (broker.portfolio() timeout + double-response guard)', { timeout: 30000 }, () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let app: express.Express;
  let racedApp: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_v2orch_timeout_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    const { db, sqliteDb: raw } = await import('../db');
    sqliteDb = raw;
    const schema = await import('../db/schema');
    await db.insert(schema.settings).values({ budget: 100, maxTradeSize: 3000 });
    const { v2Router } = await import('./v2System');

    app = express();
    app.use('/api/v2', v2Router);

    // Mirrors server.ts's real global 15s per-request backstop: responds once, first, on the
    // exact same path, then calls next() so the real handler keeps running - reproducing "the
    // backstop already sent 504, then the slow handler finally resolves and tries to write
    // again" without waiting 15 real seconds in this test.
    racedApp = express();
    racedApp.use('/api/v2/orchestration/capital', (req, res, next) => {
      res.status(504).json({ error: 'Request Timeout (simulated backstop)' });
      next();
    });
    racedApp.use('/api/v2', v2Router);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('does not hang forever when broker.portfolio() never resolves - bounded by the fallback timeout', async () => {
    const startedAt = Date.now();
    const res = await request(app).get('/api/v2/orchestration/capital');
    const elapsedMs = Date.now() - startedAt;

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.available).toBe(false);
    expect(res.body.what).toBe('BROKER DATA UNAVAILABLE');
    // The fix bounds broker.portfolio() to 5000ms; give generous slack for CI/test overhead
    // while still proving this is not an unbounded hang.
    expect(elapsedMs).toBeLessThan(10000);
  });

  it('does not throw ERR_HTTP_HEADERS_SENT when a response was already sent before broker.portfolio() resolves', async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      // racedApp's extra middleware sends the 504 first (simulating the global backstop), then
      // calls next() into the real handler, whose broker.portfolio() never resolves (mockBroker
      // above) and will eventually reject via this route's own 5s timeout.
      await request(racedApp).get('/api/v2/orchestration/capital');
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
