import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

/**
 * H1 (2026-10-12): POST /api/v1/autobot/toggle used to forward req.body to
 * TradingEngine.toggle() with NO numeric bounds check (only /config/settings had one via
 * validateSettingsBounds()). The bound check now lives at the top of toggle() itself, so this
 * route is covered too: an out-of-bounds body must be rejected with 400 + {ok:false}, and a
 * rejected toggle must have no side effect on engine state.
 *
 * Route-test pattern mirrors v2System.toggle.test.ts: mount the real autobotRouter on a real
 * express app (supertest, no listening server) backed by an isolated temp SQLite DB.
 */
describe('POST /api/v1/autobot/toggle - H1 numeric bounds', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let tradingEngine: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_autobottoggle_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.PAPER_TRADING_ONLY = 'true';

    ({ sqliteDb } = await import('../db'));
    ({ tradingEngine } = await import('../engines/TradingEngine'));
    // This suite verifies request/response + state, not background worker startup.
    const { system } = await import('../core/SystemBootstrap');
    vi.spyOn(system, 'start').mockImplementation(() => {});
    vi.spyOn(system, 'stop').mockImplementation(() => {});

    await tradingEngine.initialize();

    const { autobotRouter } = await import('./autobotRoutes');
    app = express();
    app.use(express.json());
    app.use('/api/v1/autobot', autobotRouter);
  }, 120_000);

  afterAll(() => {
    vi.restoreAllMocks();
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('rejects a negative numeric with 400 + {ok:false} and leaves state untouched', async () => {
    const before = tradingEngine.state.maxTradeSize;
    const res = await request(app)
      .post('/api/v1/autobot/toggle')
      .send({ maxTradeSize: -50 });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('maxTradeSize');
    expect(tradingEngine.state.maxTradeSize).toBe(before);
  });

  it('rejects a zero-where-positive-required numeric (budget min is 1)', async () => {
    const before = tradingEngine.state.budget;
    const res = await request(app)
      .post('/api/v1/autobot/toggle')
      .send({ budget: 0 });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('budget');
    expect(tradingEngine.state.budget).toBe(before);
  });

  it('rejects an absurdly large numeric (budget far above the configured max)', async () => {
    const before = tradingEngine.state.budget;
    const res = await request(app)
      .post('/api/v1/autobot/toggle')
      .send({ budget: 1e15 });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('budget');
    expect(tradingEngine.state.budget).toBe(before);
  });

  it('rejects a non-numeric value where a number belongs', async () => {
    // JSON cannot carry NaN; a string where a finite number belongs must also be rejected.
    const before = tradingEngine.state.dailyLossLimit;
    const res = await request(app)
      .post('/api/v1/autobot/toggle')
      .send({ dailyLossLimit: 'a lot' });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('dailyLossLimit');
    expect(tradingEngine.state.dailyLossLimit).toBe(before);
  });

  it('accepts an in-bounds numeric body and applies it', async () => {
    const res = await request(app)
      .post('/api/v1/autobot/toggle')
      .send({ minAiConfidence: 80 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(tradingEngine.state.minAiConfidence).toBe(80);

    // Restore the default for suite isolation.
    const restore = await request(app)
      .post('/api/v1/autobot/toggle')
      .send({ minAiConfidence: 75 });
    expect(restore.status).toBe(200);
  });
});
