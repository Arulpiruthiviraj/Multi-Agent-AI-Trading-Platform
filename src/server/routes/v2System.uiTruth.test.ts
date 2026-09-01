import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

/**
 * Real integration tests (isolated temp SQLite DB, real Express router via supertest) for Phase 1A
 * of the Remediation Verification Pass's UI-truth-wiring follow-up: GET /api/v2/market/sentiment-trend
 * and GET /api/v2/trading/execution-quality. Both used to back fully-fabricated frontend charts
 * (MarketSentimentTrend.tsx's hardcoded MockSentimentData, ExecutionQualityChart.tsx's
 * Date.now()-jittered scatter data) - these tests prove the replacement endpoints compute real
 * aggregates from real rows, and honestly report `available:false` rather than an empty-but-200
 * response when there is no real data to show.
 */
describe('GET /api/v2/market/sentiment-trend and /api/v2/trading/execution-quality', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_v2uitruth_${Date.now()}_${process.pid}.db`);
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

  describe('sentiment-trend', () => {
    it('honestly reports available:false when there are no real scored news articles', async () => {
      const res = await request(app).get('/api/v2/market/sentiment-trend');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.available).toBe(false);
      expect(res.body.data).toEqual([]);
    });

    it('computes a real daily-averaged sentiment from real news_articles rows', async () => {
      const today = new Date().toISOString().slice(0, 10);
      await db.insert(schema.newsArticles).values([
        { id: 'art-1', title: 'A', source: 'test', publishedAt: `${today}T09:00:00.000Z`, sentimentScore: 80 },
        { id: 'art-2', title: 'B', source: 'test', publishedAt: `${today}T15:00:00.000Z`, sentimentScore: 60 },
        // Unscored article - must not be counted in the average or its article count.
        { id: 'art-3', title: 'C', source: 'test', publishedAt: `${today}T16:00:00.000Z`, sentimentScore: null },
      ]);

      const res = await request(app).get('/api/v2/market/sentiment-trend');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.available).toBe(true);
      const todayPoint = res.body.data.find((d: any) => d.date === today);
      expect(todayPoint).toBeTruthy();
      expect(todayPoint.sentiment).toBe(70); // (80 + 60) / 2, the unscored article excluded
      expect(todayPoint.articleCount).toBe(2);
    });
  });

  describe('execution-quality', () => {
    it('honestly reports available:false when there are no FILLED trades with timing data', async () => {
      const res = await request(app).get('/api/v2/trading/execution-quality');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.available).toBe(false);
      expect(res.body.data).toEqual([]);
    });

    it('computes real submit-to-fill latency from real trades rows, never fabricating slippage', async () => {
      const submittedAt = new Date(Date.now() - 5000).toISOString();
      const filledAt = new Date().toISOString();
      await db.insert(schema.trades).values({
        id: 'exec-1', symbol: 'AAPL', side: 'BUY', quantity: 42, price: 150,
        status: 'FILLED', timestamp: filledAt, submittedAt, filledAt,
      });
      // A PENDING trade (no filledAt yet) must be excluded, not counted as zero-latency.
      await db.insert(schema.trades).values({
        id: 'exec-2', symbol: 'MSFT', side: 'SELL', quantity: 10, price: 400,
        status: 'PENDING', timestamp: new Date().toISOString(), submittedAt: new Date().toISOString(),
      });

      const res = await request(app).get('/api/v2/trading/execution-quality');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.available).toBe(true);
      expect(res.body.data).toHaveLength(1);
      const point = res.body.data[0];
      expect(point.id).toBe('exec-1');
      expect(point.quantity).toBe(42);
      expect(point.speedMs).toBeGreaterThanOrEqual(4900);
      expect(point.speedMs).toBeLessThan(15000);
      expect(point).not.toHaveProperty('slippageBps');
    });

    it('excludes HISTORICAL_REPLAY fills from execution quality (real defect found Phase 16: no environment filter meant a same-day replay run would be counted as real broker latency)', async () => {
      const submittedAt = new Date(Date.now() - 3000).toISOString();
      const filledAt = new Date().toISOString();
      await db.insert(schema.trades).values({
        id: 'exec-replay-1', symbol: 'NVDA', side: 'BUY', quantity: 5, price: 900,
        status: 'FILLED', timestamp: filledAt, submittedAt, filledAt,
        executionEnvironment: 'REPLAY', brokerId: 'historical_replay',
      });
      const res = await request(app).get('/api/v2/trading/execution-quality');
      expect(res.status).toBe(200);
      expect(res.body.data.find((d: any) => d.id === 'exec-replay-1')).toBeUndefined();
    });
  });
});
