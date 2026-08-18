import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

/**
 * Real integration test (isolated temp SQLite DB, real Express router mounted via supertest) for
 * Phase 3B's two new v2 strategy endpoints - /strategy/rsi-scan and /strategy/agent-synergy -
 * which replace StrategyScanner.tsx's/StrategySynergyMatrix.tsx's fabricated data (see
 * AgentSynergy.ts's own header comment for the full before/after). No ALPACA_API_KEY/SECRET is
 * set, so ensureBars() throws internally on every symbol; the route falls back to whatever real
 * bars are already seeded in ohlcv_bars, which is exactly what this test seeds directly.
 */
describe('v2System strategy routes - Phase 3B real RSI/synergy data', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_v2strategy_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    // Re-delete after the above imports: something in the '../db' chain (dotenv's default,
    // non-override .config() re-populating any key that is currently absent) was observed to
    // restore these from the real .env once HistoricalDataGateway's feed=iex fix made the
    // resulting live Alpaca call actually succeed instead of 403ing - silently pulling real bars
    // on top of this test's seeded fixture and breaking the exact-barsUsed assertions below.
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;

    // 25 daily bars for AAPL (above RSI_MIN_BARS=20), alternating up/down so RSI is a real,
    // non-trivial number rather than the 0/100 edge case.
    const baseTs = Date.now() - 25 * 24 * 60 * 60 * 1000;
    let price = 100;
    for (let i = 0; i < 25; i++) {
      price += i % 3 === 0 ? -1.5 : 1;
      const ts = baseTs + i * 24 * 60 * 60 * 1000;
      await db.insert(schema.ohlcvBars).values({
        id: `AAPL:1Day:${ts}`, symbol: 'AAPL', timeframe: '1Day', timestamp: ts,
        open: price, high: price + 1, low: price - 1, close: price, volume: 1_000_000, source: 'alpaca',
      });
    }
    // Only 5 bars for MSFT - below RSI_MIN_BARS, must report dataAvailable:false.
    for (let i = 0; i < 5; i++) {
      const ts = baseTs + i * 24 * 60 * 60 * 1000;
      await db.insert(schema.ohlcvBars).values({
        id: `MSFT:1Day:${ts}`, symbol: 'MSFT', timeframe: '1Day', timestamp: ts,
        open: 50, high: 51, low: 49, close: 50, volume: 500_000, source: 'alpaca',
      });
    }

    // Real agent_predictions rows: TechnicalAgent and NewsAgent moving together on AAPL across 6
    // recent days (real positive correlation, inside the route's 30-day window), FundamentalAgent
    // left with no overlapping data at all. Days are relative to "now" (not hardcoded literals) -
    // the route filters by a rolling 30-day window off the real current date.
    const days = [1, 2, 3, 4, 5, 6].map(d => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
    const vals = [0.9, -0.8, 0.7, -0.6, 0.85, -0.75];
    let predId = 0;
    for (let k = 0; k < days.length; k++) {
      const prediction = vals[k] > 0 ? 'BUY' : 'SELL';
      const confidence = Math.abs(vals[k]);
      for (const agentName of ['TechnicalAgent', 'NewsAgent']) {
        await db.insert(schema.agentPredictions).values({
          id: `pred-${predId++}`, agentName, symbol: 'AAPL', prediction, confidence,
          reasoning: 'test fixture', timestamp: `${days[k]}T12:00:00.000Z`,
        });
      }
    }

    const { v2Router } = await import('./v2System');
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;
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

  describe('GET /strategy/rsi-scan', () => {
    it('returns a real RSI computed from real seeded bars for a symbol with enough history', async () => {
      const res = await request(app).get('/api/v2/strategy/rsi-scan?symbols=AAPL');
      expect(res.status).toBe(200);
      const aapl = res.body.results.find((r: any) => r.symbol === 'AAPL');
      expect(aapl.dataAvailable).toBe(true);
      expect(aapl.rsi).toBeGreaterThan(0);
      expect(aapl.rsi).toBeLessThan(100);
      expect(['OVERBOUGHT', 'OVERSOLD', 'NEUTRAL']).toContain(aapl.signal);
      expect(aapl.barsUsed).toBe(25);
    });

    it('honestly reports dataAvailable:false for a symbol with too few real bars', async () => {
      const res = await request(app).get('/api/v2/strategy/rsi-scan?symbols=MSFT');
      expect(res.status).toBe(200);
      const msft = res.body.results.find((r: any) => r.symbol === 'MSFT');
      expect(msft.dataAvailable).toBe(false);
      expect(msft.reason).toBeTruthy();
    });

    it('flags BTC as unavailable rather than fabricating crypto RSI', async () => {
      const res = await request(app).get('/api/v2/strategy/rsi-scan?symbols=BTC');
      expect(res.status).toBe(200);
      const btc = res.body.results.find((r: any) => r.symbol === 'BTC');
      expect(btc.dataAvailable).toBe(false);
      expect(btc.reason).toMatch(/crypto/i);
    });

    it('defaults to the real default symbol list when no ?symbols= is given', async () => {
      const res = await request(app).get('/api/v2/strategy/rsi-scan');
      expect(res.status).toBe(200);
      expect(res.body.results.length).toBeGreaterThan(1);
      expect(res.body.results.some((r: any) => r.symbol === 'AAPL')).toBe(true);
    });
  });

  describe('GET /strategy/agent-synergy', () => {
    it('computes a real positive correlation between TechnicalAgent and NewsAgent from real predictions', async () => {
      const res = await request(app).get('/api/v2/strategy/agent-synergy');
      expect(res.status).toBe(200);
      expect(res.body.agents).toEqual(['TechnicalAgent', 'NewsAgent', 'FundamentalAgent', 'MacroAgent', 'KronosForecastAgent']);
      const i = res.body.agents.indexOf('TechnicalAgent');
      const j = res.body.agents.indexOf('NewsAgent');
      expect(res.body.matrix[i][j]).not.toBeNull();
      expect(res.body.matrix[i][j]).toBeGreaterThan(0.9);
    });

    it('reports null (not a fabricated number) for agent pairs with no real overlapping data', async () => {
      const res = await request(app).get('/api/v2/strategy/agent-synergy');
      const i = res.body.agents.indexOf('TechnicalAgent');
      const j = res.body.agents.indexOf('FundamentalAgent');
      expect(res.body.matrix[i][j]).toBeNull();
    });
  });
});
