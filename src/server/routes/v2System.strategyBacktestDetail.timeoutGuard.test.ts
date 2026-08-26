import { describe, it, expect, vi, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Regression coverage for a real, live defect found in data/logs/crash.log
 * (ERR_HTTP_HEADERS_SENT unhandledRejections pointing at
 * GET /api/v2/quant/strategy-backtests/:id): backtestEngine.getStrategyRun() had no timeout of
 * its own. A slow/hanging lookup could keep the handler pending past server.ts's global 15s
 * per-request backstop, which sends its own response first - this handler's eventual
 * res.status(404)/res.json()/res.status(500).json() then threw on the second write.
 *
 * Fixed the same way as GET /api/v2/market/sentiment-trend
 * (v2System.sentimentTrend.timeoutGuard.test.ts): bound the slow call to 5s (well under the 15s
 * backstop) and guard every write in the handler with res.headersSent.
 */
const { hangingGetStrategyRun } = vi.hoisted(() => ({
  hangingGetStrategyRun: vi.fn(() => new Promise(() => { /* never resolves */ })),
}));

vi.mock('../engines/backtest/BacktestEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/backtest/BacktestEngine')>();
  return { ...actual, backtestEngine: { ...actual.backtestEngine, getStrategyRun: hangingGetStrategyRun } };
});

describe('GET /api/v2/quant/strategy-backtests/:id (getStrategyRun timeout + double-response guard)', { timeout: 30000 }, () => {
  let app: express.Express;
  let racedApp: express.Express;

  beforeAll(async () => {
    const { v2Router } = await import('./v2System');

    app = express();
    app.use('/api/v2', v2Router);

    // Mirrors server.ts's real global 15s per-request backstop: responds once, first, on the
    // exact same path, then calls next() so the real handler keeps running.
    racedApp = express();
    racedApp.use('/api/v2/quant/strategy-backtests/:id', (req, res, next) => {
      res.status(504).json({ error: 'Request Timeout (simulated backstop)' });
      next();
    });
    racedApp.use('/api/v2', v2Router);
  });

  it('does not hang forever when getStrategyRun() never resolves - bounded by the fallback timeout', async () => {
    const startedAt = Date.now();
    const res = await request(app).get('/api/v2/quant/strategy-backtests/some-run-id');
    const elapsedMs = Date.now() - startedAt;

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(elapsedMs).toBeLessThan(10000);
  });

  it('does not throw ERR_HTTP_HEADERS_SENT when a response was already sent before getStrategyRun() rejects', async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      await request(racedApp).get('/api/v2/quant/strategy-backtests/some-run-id');
      await new Promise((r) => setTimeout(r, 6500));
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }

    const headersSentErrors = unhandledRejections.filter(
      (e) => e instanceof Error && e.message.includes('ERR_HTTP_HEADERS_SENT'),
    );
    expect(headersSentErrors).toEqual([]);
  }, 15000);

  it('success path is unaffected: a real run resolves in a single 200 response', async () => {
    hangingGetStrategyRun.mockResolvedValueOnce({
      id: 'run-1', strategyId: 'MOMENTUM_BREAKOUT', symbol: 'AAPL', tradeLog: '[]',
      regimeBreakdown: null, expectedValue: null, kelly: null, equityCurve: '[]', benchmarkComparison: null,
    });
    const res = await request(app).get('/api/v2/quant/strategy-backtests/run-1');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe('run-1');
  });

  it('not-found path is unaffected: a missing run resolves in a single 404 response', async () => {
    hangingGetStrategyRun.mockResolvedValueOnce(null);
    const res = await request(app).get('/api/v2/quant/strategy-backtests/missing-run');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });
});
