import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

describe('Phase 17 research routes', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_research_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.OPENALICE_ENABLED = 'false';
    ({ sqliteDb } = await import('../db'));
    const { v2Router } = await import('../routes/v2System');
    app = express();
    app.use(express.json());
    app.use('/api/v2', v2Router);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('GET vectorbt status never claims order placement', async () => {
    const res = await request(app).get('/api/v2/research/vectorbt/status');
    expect(res.status).toBe(200);
    expect(res.body.canPlaceOrders).toBe(false);
    expect(res.body.live).toBe('NO-GO');
    expect(res.body.quantAutoEnabled).toBe(false);
  });

  it('CORE strategy VectorBT backtest is FEATURE_SUBSET_PARITY UNTESTED without invented PnL', async () => {
    const res = await request(app).post('/api/v2/research/vectorbt/backtest').send({ strategyId: 'MOMENTUM_BREAKOUT' });
    expect(res.status).toBe(200);
    expect(res.body.adapter).toBe('FEATURE_SUBSET_PARITY');
    expect(res.body.status).toBe('UNTESTED');
    expect(res.body.inventedResults).toBe(false);
    expect(res.body.netPnl).toBeUndefined();
    expect(res.body.canPlaceOrders).toBe(false);
  });

  it('promotion endpoint cannot be LIVE_CANDIDATE without evidence', async () => {
    const res = await request(app).get('/api/v2/research/promotion/TREND_FOLLOWING');
    expect(res.body.status).toBe('UNTESTED');
    expect(res.body.live.live).toBe('NO-GO');
    expect(res.body.cannotSetStatusByConfig).toBe(true);
  });

  it('golden dataset route reports hash and quality', async () => {
    const res = await request(app).get('/api/v2/research/dataset/golden');
    expect(res.body.dataHash).toMatch(/^sha256:/);
    expect(res.body.quality.liveCandidateAllowed).toBe(false);
  });

  it('capital labels keep broker equity unavailable when missing', async () => {
    const res = await request(app).get('/api/v2/research/capital-labels');
    expect(res.body.brokerEquityAvailable).toBe(false);
    expect(res.body.brokerEquity).toBeNull();
    expect(res.body.paperInitialCapital).toBe(100000);
    expect(res.body.defaultMaxTradeSizeDollars).toBe(3000);
    expect(res.body.paperInitialCapital).not.toBe(res.body.defaultMaxTradeSizeDollars);
  });

  it('warehouse inventory does not invent GREEN parquet and cannot place orders', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus_warehouse_empty_'));
    const prev = process.env.ARGUS_RESEARCH_DIR;
    process.env.ARGUS_RESEARCH_DIR = emptyDir;
    try {
      // Re-import path is not needed — researchDataDir() reads env on every call.
      // Assert dir echoes the empty temp path so cwd data/research cannot leak into this assertion.
      const res = await request(app).get('/api/v2/research/warehouse');
      expect(res.status).toBe(200);
      expect(path.resolve(String(res.body.dir))).toBe(path.resolve(emptyDir));
      expect(res.body.canPlaceOrders).toBe(false);
      expect(res.body.live).toBe('NO-GO');
      expect(res.body.greenRealMarketData).toBe(false);
      expect(res.body.greenParquetCount).toBe(0);
      expect(res.body.sidecarCount).toBe(0);
      expect(String(res.body.note || '')).toMatch(/absent|No GREEN|Empty is not GREEN/i);
    } finally {
      if (prev === undefined) delete process.env.ARGUS_RESEARCH_DIR;
      else process.env.ARGUS_RESEARCH_DIR = prev;
      try { fs.rmSync(emptyDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});
