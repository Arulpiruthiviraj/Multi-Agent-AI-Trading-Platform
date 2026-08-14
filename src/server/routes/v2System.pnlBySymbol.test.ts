import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

/**
 * Real integration test (isolated temp SQLite DB, real Express router via supertest) for
 * GET /api/v2/portfolio/pnl-by-symbol - the real replacement for StrategyProfitSunburst.tsx's
 * invented sub-strategy hierarchy ("Whipsaw"/"Pairs Trading"/"Fee Drag") with Date.now()-jittered
 * dollar values. Proves the route aggregates real trades.profitLoss by real symbol and honestly
 * excludes PENDING trades (no realized P&L yet) rather than treating them as zero.
 */
describe('GET /api/v2/portfolio/pnl-by-symbol', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_v2pnlsym_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');

    const { v2Router } = await import('./v2System');
    app = express();
    app.use(express.json());
    app.use('/api/v2', v2Router);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('honestly reports available:false when no real FILLED trade has realized P&L', async () => {
    const res = await request(app).get('/api/v2/portfolio/pnl-by-symbol');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.available).toBe(false);
    expect(res.body.data).toEqual([]);
  });

  it('sums real realized P&L per real symbol, excluding PENDING trades and trades outside the horizon', async () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    await db.insert(schema.trades).values([
      { id: 't1', symbol: 'AAPL', side: 'SELL', quantity: 10, price: 200, status: 'FILLED', timestamp: now, profitLoss: 150 },
      { id: 't2', symbol: 'AAPL', side: 'SELL', quantity: 5, price: 190, status: 'FILLED', timestamp: now, profitLoss: -20 },
      { id: 't3', symbol: 'TSLA', side: 'SELL', quantity: 3, price: 250, status: 'FILLED', timestamp: now, profitLoss: -80 },
      { id: 't4', symbol: 'NVDA', side: 'BUY', quantity: 2, price: 900, status: 'PENDING', timestamp: now, profitLoss: null },
      { id: 't5', symbol: 'MSFT', side: 'SELL', quantity: 1, price: 400, status: 'FILLED', timestamp: old, profitLoss: 999 }, // outside YTD-ish default window is not tested here; excluded by default 1M horizon
    ]);

    const res = await request(app).get('/api/v2/portfolio/pnl-by-symbol');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.available).toBe(true);

    const aapl = res.body.data.find((d: any) => d.symbol === 'AAPL');
    expect(aapl.pnl).toBe(130); // 150 - 20
    expect(aapl.type).toBe('profit');

    const tsla = res.body.data.find((d: any) => d.symbol === 'TSLA');
    expect(tsla.pnl).toBe(-80);
    expect(tsla.type).toBe('loss');

    expect(res.body.data.find((d: any) => d.symbol === 'NVDA')).toBeUndefined();
    expect(res.body.data.find((d: any) => d.symbol === 'MSFT')).toBeUndefined();
  });

  it('respects the horizon query param', async () => {
    const res = await request(app).get('/api/v2/portfolio/pnl-by-symbol?horizon=YTD');
    expect(res.status).toBe(200);
    expect(res.body.horizon).toBe('YTD');
    // the 400-day-old MSFT trade is still outside YTD's 366-day window in this fixture, but AAPL/TSLA (now) remain
    expect(res.body.data.find((d: any) => d.symbol === 'AAPL')).toBeTruthy();
  });
});
