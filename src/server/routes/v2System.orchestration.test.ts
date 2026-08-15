import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

const { mockBroker } = vi.hoisted(() => ({
  mockBroker: {
    portfolio: vi.fn(async () => ({
      equity: 2137.42, cash: 2137.42, buyingPower: 2137.42, unrealizedPnl: 0, realizedPnl: 0,
      positions: [{ symbol: 'AAPL', quantity: 1, averagePrice: 63.42 }],
    })),
    orders: vi.fn(async () => []),
  },
}));

vi.mock('../../brokers/BrokerManager', () => ({
  BrokerManager: { getInstance: () => ({ getActiveBroker: () => mockBroker }) },
}));

describe('GET /api/v2/orchestration/capital', { timeout: 30000 }, () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_v2orch_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    const { db, sqliteDb: raw } = await import('../db');
    sqliteDb = raw;
    const schema = await import('../db/schema');
    await db.insert(schema.settings).values({ budget: 100, maxTradeSize: 3000 });
    const { v2Router } = await import('./v2System');
    app = express();
    app.use('/api/v2', v2Router);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('reports broker equity separately from remaining Argus allocation', async () => {
    const res = await request(app).get('/api/v2/orchestration/capital');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.broker.equity).toBe(2137.42);
    expect(res.body.argus.allocated).toBe(100);
    expect(res.body.argus.used).toBeCloseTo(63.42, 5);
    expect(res.body.argus.remaining).toBeCloseTo(36.58, 5);
  });
});
