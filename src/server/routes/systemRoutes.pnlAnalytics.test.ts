import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

/**
 * Regression coverage for a real, live defect found in data/logs/crash.log (repeated
 * ERR_HTTP_HEADERS_SENT unhandledRejections through 2026-08-20): GET /api/v1/pnl/analytics's
 * paper-broker fallback path called broker.portfolio() with no timeout of its own. If the
 * primary Alpaca history fetch above it was slow/degraded (it shares tradingSafety's
 * alpacaRequestTimeoutMs - the same 15000ms as server.ts's global per-request backstop), the
 * backstop could already have responded 504 by the time this fallback finally resolved and tried
 * to res.json() a second time on an already-sent response, throwing ERR_HTTP_HEADERS_SENT.
 *
 * This suite proves: (1) the fallback path itself still works end-to-end, (2) a hung
 * broker.portfolio() no longer blocks the response indefinitely - it now resolves via the fixed
 * 5s bound, and (3) if a response has already been sent before broker.portfolio() resolves, the
 * handler no longer throws (the res.headersSent guard added in this fix).
 */
describe('GET /api/v1/pnl/analytics (broker.portfolio() fallback timeout + double-response guard)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let app: express.Express;
  let racedApp: express.Express;
  let BrokerManager: any;
  let bm: any;
  let originalActiveBroker: any;
  let originalAlpacaKey: string | undefined;
  let originalAlpacaSecret: string | undefined;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_pnlanalytics_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    // Force the paper-broker fallback path deterministically (no live Alpaca network calls in
    // this suite) - this route's primary branch is gated on these two env vars being present.
    // Set to '' rather than deleted: some transitively-imported module (EncryptionService.ts)
    // calls dotenv.config() at import time, which only fills in keys that are currently
    // undefined - deleting them here would just have dotenv silently restore the developer's
    // real .env values on the next import below (see vitest.setup.ts's own note on this).
    originalAlpacaKey = process.env.ALPACA_API_KEY;
    originalAlpacaSecret = process.env.ALPACA_SECRET_KEY;
    process.env.ALPACA_API_KEY = '';
    process.env.ALPACA_SECRET_KEY = '';

    ({ sqliteDb } = await import('../db'));
    ({ BrokerManager } = await import('../../brokers/BrokerManager'));
    const { systemRouter } = await import('./systemRoutes');

    app = express();
    app.use(express.json());
    app.use('/api/v1', systemRouter);

    // Separate app: mirrors server.ts's real global 15s per-request backstop (the actual
    // component that races this route in production) - responds once, first, on the exact same
    // path, then calls next() so the real handler keeps running - exactly reproducing "the
    // backstop already sent 504, then the slow handler finally resolves and tries to write
    // again" without waiting 15 real seconds in this test.
    racedApp = express();
    racedApp.use(express.json());
    racedApp.use('/api/v1/pnl/analytics', (req, res, next) => {
      res.status(504).json({ error: 'Request Timeout (simulated backstop)' });
      next();
    });
    racedApp.use('/api/v1', systemRouter);

    bm = BrokerManager.getInstance();
    originalActiveBroker = bm.getActiveBroker();
  });

  afterEach(() => {
    (bm as any).activeBroker = originalActiveBroker;
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
    if (originalAlpacaKey !== undefined) process.env.ALPACA_API_KEY = originalAlpacaKey;
    if (originalAlpacaSecret !== undefined) process.env.ALPACA_SECRET_KEY = originalAlpacaSecret;
  });

  it('returns a valid pnl/analytics body via the paper-broker fallback path', async () => {
    const res = await request(app).get('/api/v1/pnl/analytics');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.history)).toBe(true);
    expect(typeof res.body.summary.totalProfitLoss).toBe('number');
  });

  it('does not hang forever when broker.portfolio() never resolves - bounded by the fallback timeout', async () => {
    (bm as any).activeBroker = {
      id: 'hung-broker-test-double',
      name: 'HungBrokerTestDouble',
      portfolio: vi.fn(() => new Promise(() => { /* never resolves */ })),
    };

    const startedAt = Date.now();
    const res = await request(app).get('/api/v1/pnl/analytics');
    const elapsedMs = Date.now() - startedAt;

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ history: [], summary: { winRate: 0, totalProfitLoss: 0 } });
    // The fix bounds broker.portfolio() to 5000ms; give generous slack for CI/test overhead
    // while still proving this is not an unbounded hang.
    expect(elapsedMs).toBeLessThan(10000);
  }, 15000);

  it('does not throw ERR_HTTP_HEADERS_SENT when a response was already sent before broker.portfolio() resolves', async () => {
    let resolvePortfolio: (v: { equity: number; cash: number }) => void;
    const portfolioPromise = new Promise<{ equity: number; cash: number }>((resolve) => {
      resolvePortfolio = resolve;
    });
    (bm as any).activeBroker = {
      id: 'late-broker-test-double',
      name: 'LateBrokerTestDouble',
      portfolio: vi.fn(() => portfolioPromise),
    };

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      // racedApp's extra middleware sends the 504 first (simulating the global backstop),
      // then calls next() into the real /pnl/analytics handler, whose broker.portfolio() is
      // still pending on portfolioPromise below.
      const reqPromise = request(racedApp).get('/api/v1/pnl/analytics');
      await new Promise((r) => setTimeout(r, 50));
      resolvePortfolio!({ equity: 100000, cash: 100000 });
      await reqPromise;
      // Give the handler's post-await continuation a tick to run and (pre-fix) throw.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }

    const headersSentErrors = unhandledRejections.filter(
      (e) => e instanceof Error && e.message.includes('ERR_HTTP_HEADERS_SENT'),
    );
    expect(headersSentErrors).toEqual([]);
  }, 15000);
});
