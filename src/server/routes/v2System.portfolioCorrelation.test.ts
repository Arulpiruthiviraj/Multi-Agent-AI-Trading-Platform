import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

/**
 * 2026-09-11 - GET /api/v2/portfolio/correlation: wires the already-existing, already-safe
 * runCorrelationResearch() (CorrelationResearch.ts, same returnCorrelation() RiskEngine gate #20
 * already relies on) to the account's REAL current open portfolio holdings, instead of only being
 * reachable via POST /api/research-intelligence/correlation with a caller-supplied symbol list.
 * Mocks historicalDataGateway (network/broker-dependent) exactly like
 * v2System.sentimentTrend.timeoutGuard.test.ts already does for db - never hits a real API in tests.
 */
const { fakeBarsBySymbol } = vi.hoisted(() => ({ fakeBarsBySymbol: new Map<string, { timestamp: number; open: number; high: number; low: number; close: number; volume: number }[]>() }));

vi.mock('../engines/backtest/HistoricalDataGateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/backtest/HistoricalDataGateway')>();
  return {
    ...actual,
    historicalDataGateway: {
      ensureBars: async () => undefined,
      getBars: async (symbol: string) => fakeBarsBySymbol.get(symbol) ?? [],
    },
  };
});

describe('GET /api/v2/portfolio/correlation', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_v2portfoliocorr_${Date.now()}_${process.pid}.db`);
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

  it('honestly reports available:false with fewer than 2 real open positions', async () => {
    const res = await request(app).get('/api/v2/portfolio/correlation');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.available).toBe(false);
    expect(res.body.data).toBeNull();
  });

  it('computes real pairwise correlation from real portfolio holdings via the unmodified research function', async () => {
    const lastUpdated = new Date().toISOString();
    await db.insert(schema.portfolio).values([
      { symbol: 'PCORA', quantity: 10, averagePrice: 100, currentPrice: 110, lastUpdated },
      { symbol: 'PCORB', quantity: 5, averagePrice: 200, currentPrice: 210, lastUpdated },
      { symbol: 'PCORC', quantity: 0, averagePrice: 50, currentPrice: 55, lastUpdated }, // closed, must be excluded
    ]);

    // Perfectly correlated series (identical returns) for the two open symbols - must clear
    // tradingSafety.json's real correlationMinOverlap (20) + 1 data points, the same floor
    // RiskEngine gate #20 (correlation_exposure) uses via the same returnCorrelation().
    const closesA = Array.from({ length: 25 }, (_, i) => 100 + (i % 2 === 0 ? i * 0.4 : -i * 0.2));
    fakeBarsBySymbol.set('PCORA', closesA.map((close, i) => ({ timestamp: i, open: close, high: close, low: close, close, volume: 1000 })));
    fakeBarsBySymbol.set('PCORB', closesA.map((close, i) => ({ timestamp: i, open: close * 2, high: close * 2, low: close * 2, close: close * 2, volume: 1000 })));

    const res = await request(app).get('/api/v2/portfolio/correlation');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.available).toBe(true);
    expect(res.body.canPlaceOrders).toBe(false);
    expect(res.body.isLiveTrade).toBe(false);

    const pairs = res.body.data.pairs;
    expect(pairs.length).toBe(1); // exactly PCORA/PCORB - PCORC excluded (quantity 0)
    expect(pairs[0].correlation).toBeCloseTo(1, 5); // identical relative returns -> perfect correlation
    expect(res.body.data.diversificationScore).toBeCloseTo(0, 5); // 1 - |1| = 0
  });
});
