/**
 * POST /api/v2/trading/execute-override — full consensus path (no ManualOverride skip).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDbPath = path.join(os.tmpdir(), `argus-override-consensus-${Date.now()}.db`);
process.env.ARGUS_DB_PATH = tmpDbPath;
process.env.PAPER_TRADING_ONLY = 'true';

describe('POST /api/v2/trading/execute-override — consensus-required manual path', () => {
  let app: express.Express;
  let marketDataWorker: typeof import('../services/MarketDataWorker').marketDataWorker;
  let tradingEngine: typeof import('../engines/TradingEngine').tradingEngine;
  let db: typeof import('../db').db;
  let schema: typeof import('../db/schema');

  beforeAll(async () => {
    await import('../db');
    ({ marketDataWorker } = await import('../services/MarketDataWorker'));
    ({ tradingEngine } = await import('../engines/TradingEngine'));
    ({ db } = await import('../db'));
    schema = await import('../db/schema');
    const { v2Router } = await import('./v2System');
    app = express();
    app.use(express.json());
    app.use('/api/v2', v2Router);
  });

  beforeEach(() => {
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
  });

  afterAll(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('rejects a request missing symbol/side with a 400', async () => {
    const res = await request(app).post('/api/v2/trading/execute-override').send({ symbol: 'AAPL' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('refuses a symbol with no real live price', async () => {
    const res = await request(app).post('/api/v2/trading/execute-override').send({ symbol: 'ZZZZ_NO_TICK', side: 'BUY' });
    expect(res.status).toBe(422);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/no real live price/i);
  });

  it('does not skip consensus — without multi-agent agreement returns TRADE_REJECTED_CONSENSUS', async () => {
    marketDataWorker.cacheObservedQuote('OVRTEST', 123.45);

    const res = await request(app).post('/api/v2/trading/execute-override').send({ symbol: 'OVRTEST', side: 'BUY' });
    // Co-eval may take time; timeout or reject both are fail-closed (not silent ManualOverride).
    expect([409, 200]).toContain(res.status);
    if (res.status === 409) {
      expect(res.body.ok).toBe(false);
      expect(res.body.code === 'TRADE_REJECTED_CONSENSUS' || /consensus|TRADE_REJECTED|timed out|need/i.test(String(res.body.error || ''))).toBe(true);
      expect(res.body.source).toBe('MANUAL_CONSENSUS');
    } else {
      // Rare: live agents already had ≥2 agreeing votes — still must stamp MANUAL_CONSENSUS.
      expect(res.body.source).toBe('MANUAL_CONSENSUS');
      expect(res.body.approved).toBe(true);
    }
    // Must never mint ManualOverride skip-consensus evidence.
    const evidence = await db.select().from(schema.consensusEvidence);
    const manualSkip = evidence.filter((e: any) => e.agent === 'ManualOverride');
    expect(manualSkip.length).toBe(0);
  }, 45_000);

  it('refuses BUY when Autobot is off', async () => {
    tradingEngine.state.enabled = false;
    marketDataWorker.cacheObservedQuote('OVRTEST', 123.45);

    const buy = await request(app).post('/api/v2/trading/execute-override').send({ symbol: 'OVRTEST', side: 'BUY' });
    expect(buy.status).toBe(409);
    expect(buy.body.ok).toBe(false);
    expect(buy.body.error).toMatch(/Autobot is off/i);

    tradingEngine.state.enabled = true;
  });
});
