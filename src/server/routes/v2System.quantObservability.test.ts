import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

/**
 * Real integration test (isolated temp SQLite DB, real Express router mounted via supertest,
 * same established pattern as v2System.strategy.test.ts) for the new quant-layer observability
 * routes - previously the only way to see QuantSignalAgent's/BacktestEngine.runStrategyBacktest()'s
 * real persisted output was to query SQLite directly; no route or UI read any of it.
 */
describe('v2System quant observability routes', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;
  const originalKey = process.env.ALPACA_API_KEY;
  const originalSecret = process.env.ALPACA_SECRET_KEY;

  beforeAll(async () => {
    process.env.OPENALICE_ENABLED = 'false';
    tmpDbPath = path.join(os.tmpdir(), `argus_v2quant_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_SECRET_KEY = 'test-secret';

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    await db.insert(schema.settings).values({ maxTradeSize: 5000, riskLevel: 'Balanced', maxOpenPositions: 10 });

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
    if (originalKey === undefined) delete process.env.ALPACA_API_KEY; else process.env.ALPACA_API_KEY = originalKey;
    if (originalSecret === undefined) delete process.env.ALPACA_SECRET_KEY; else process.env.ALPACA_SECRET_KEY = originalSecret;
  });

  afterEach(() => vi.unstubAllGlobals());

  describe('GET /api/v2/quant/strategies', () => {
    it('lists the 5 real strategies with their real applicable regimes and holding-period description', async () => {
      const { ALL_STRATEGIES, EXPERIMENTAL_STRATEGIES, isExperimentalStrategyLive } = await import('../quant/strategies/StrategyEngine');
      const { STRATEGY_TYPICAL_HOLDING_PERIOD } = await import('../quant/strategies/types');
      const { quantExperimentalStrategies } = await import('../config/quantExperimentalStrategies');
      const { quantStrategyTaxonomySummary } = await import('../config/quantStrategyTaxonomy');
      const ids = ALL_STRATEGIES.map((s) => s.id);
      expect(ids).toEqual(['MOMENTUM_BREAKOUT', 'PULLBACK_CONTINUATION', 'MEAN_REVERSION', 'TREND_FOLLOWING', 'RANGE_REVERSION']);
      expect(quantExperimentalStrategies.strategies.map((s: { id: string }) => s.id)).toEqual(EXPERIMENTAL_STRATEGIES.map((s) => s.id));
      expect(EXPERIMENTAL_STRATEGIES.every((s) => isExperimentalStrategyLive(s.id) === false)).toBe(true);
      expect(quantStrategyTaxonomySummary().namedTechniqueCount).toBe(760);
      expect(quantStrategyTaxonomySummary().masterFamilyCount).toBe(10);
      expect(quantStrategyTaxonomySummary().masterArchetypeCount).toBe(60);
      expect(quantStrategyTaxonomySummary().notSupportedCount).toBeGreaterThan(0);
      expect(quantStrategyTaxonomySummary().liveEvaluateAllRemainsCoreUnlessEnvFlag).toBe(true);
      const trendFollowing = ALL_STRATEGIES.find((s) => s.id === 'TREND_FOLLOWING');
      expect(trendFollowing?.applicableRegimes).toEqual(['BULLISH_TREND', 'BEARISH_TREND']);
      expect(STRATEGY_TYPICAL_HOLDING_PERIOD['TREND_FOLLOWING']).toContain('Open-ended');

      let res: any;
      try {
        res = await request(app).get('/api/v2/quant/strategies');
      } catch (e: any) {
        if (e?.code !== 'ECONNRESET' && !String(e?.message || '').includes('ECONNRESET')) throw e;
        res = await request(app).get('/api/v2/quant/strategies');
      }
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.strategies.map((s: any) => s.id)).toEqual(ids);
      expect(res.body.experimentalStrategies.every((s: any) => s.validationStatus === 'UNVALIDATED')).toBe(true);
      expect(res.body.forumStrategies.strategies.length).toBeGreaterThanOrEqual(7);
      expect(res.body.forumStrategies.strategies.find((s: any) => s.id === 'FORUM_WHEEL_OPTIONS').status).toBe('NOT_SUPPORTED');
      expect(res.body.strategies).toHaveLength(5);
    }, 45000);
  });

  describe('GET /api/v2/quant/experiments/audit-trail', () => {
    it('returns an empty, honest trial list for a strategy with no recorded trials', async () => {
      const res = await request(app).get('/api/v2/quant/experiments/audit-trail').query({ strategyId: 'STRATEGY_WITH_NO_TRIALS_' + Date.now() });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.trials).toBe(0);
      expect(res.body.trialRecords).toEqual([]);
      expect(res.body.deflatedSharpe).toBeNull();
    });

    it('returns real recorded per-trial provenance, including rejected trials, and a real DSR once enough real Sharpes exist', async () => {
      const { recordExperimentTrial } = await import('../research/experimentLedger');
      const strategyId = 'HTTP_AUDIT_TRAIL_STRATEGY_' + Date.now();
      recordExperimentTrial(strategyId, 'hash-http-1', { outOfSampleMetrics: { sharpe: 0.7 }, selectionStatus: 'REJECTED', rejectionReason: 'weak OOS Sharpe' });
      recordExperimentTrial(strategyId, 'hash-http-2', { outOfSampleMetrics: { sharpe: 1.6 }, selectionStatus: 'ACCEPTED' });

      const res = await request(app).get('/api/v2/quant/experiments/audit-trail').query({ strategyId, numObservations: 252 });
      expect(res.status).toBe(200);
      expect(res.body.trials).toBe(2);
      expect(res.body.trialRecords.map((t: any) => t.selectionStatus).sort()).toEqual(['ACCEPTED', 'REJECTED']);
      expect(res.body.trialRecords.some((t: any) => t.rejectionReason === 'weak OOS Sharpe')).toBe(true);
      expect(res.body.deflatedSharpe).not.toBeNull();
      expect(res.body.deflatedSharpe.deflatedSharpeRatio).toBeGreaterThanOrEqual(0);
      expect(res.body.deflatedSharpe.deflatedSharpeRatio).toBeLessThanOrEqual(1);

      const resNoObs = await request(app).get('/api/v2/quant/experiments/audit-trail').query({ strategyId });
      expect(resNoObs.body.deflatedSharpe).toBeNull(); // never fabricated without an explicit numObservations
    });
  });

  describe('GET /api/v2/quant/assessments/:symbol', () => {
    it('reports available:false honestly (not an empty 200 that looks the same as "not evaluated yet") when no real assessment exists', async () => {
      const res = await request(app).get('/api/v2/quant/assessments/NOASSESS');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.available).toBe(false);
      expect(res.body.data).toEqual([]);
    });

    it('returns real persisted assessments, most recent first, with every JSON field genuinely parsed', async () => {
      const regime = { regime: 'BULLISH_TREND', trendStrength: 80, volatility: 'NORMAL', marketStructure: 'TRENDING', confidence: 0.85, features: {}, insufficientData: false };
      await db.insert(schema.quantAssessments).values({
        id: 'qa-1', symbol: 'QOBS', timeframe: '1Day', regime: JSON.stringify(regime),
        marketContext: JSON.stringify({ spy: null }), strategyEvaluations: JSON.stringify([]),
        groupedScores: JSON.stringify({ BUY: { overallSetupScore: 70 } }), aiContradictionAnalysis: null,
        emittedTradeIdea: true, createdAt: new Date(Date.now() - 10000).toISOString(),
      });
      await db.insert(schema.quantAssessments).values({
        id: 'qa-2', symbol: 'QOBS', timeframe: '1Day', regime: JSON.stringify(regime),
        marketContext: JSON.stringify({ spy: null }), strategyEvaluations: null, groupedScores: null,
        aiContradictionAnalysis: null, emittedTradeIdea: false, createdAt: new Date().toISOString(),
      });

      const res = await request(app).get('/api/v2/quant/assessments/qobs'); // lowercase - real case-insensitive lookup
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].id).toBe('qa-2'); // most recent first
      expect(res.body.data[0].regime.regime).toBe('BULLISH_TREND'); // genuinely parsed, not a raw string
      expect(res.body.data[1].groupedScores.BUY.overallSetupScore).toBe(70);
    });
  });

  describe('GET /api/v2/quant/strategy-backtests', () => {
    it('lists real persisted strategy-backtest runs as lightweight summaries', async () => {
      await db.insert(schema.quantStrategyBacktests).values({
        id: 'sb-1', strategyId: 'TREND_FOLLOWING', symbol: 'TRENDX', timeframe: '1Day',
        startDate: '2023-01-01', endDate: '2023-06-01', status: 'COMPLETED',
        finalEquity: 112000, totalTrades: 2, winRatePct: 100, avgR: 5.2, maxConsecutiveLosses: 0,
        regimeBreakdown: JSON.stringify({ BULLISH_TREND: { count: 1, winRatePct: 100, expectancy: 12000 } }),
        expectedValue: null, kelly: null, tradeLog: JSON.stringify([{ side: 'BUY' }]), equityCurve: JSON.stringify([{ equity: 100000 }]),
        createdAt: new Date().toISOString(),
      });

      const res = await request(app).get('/api/v2/quant/strategy-backtests');
      expect(res.status).toBe(200);
      expect(res.body.data.some((r: any) => r.id === 'sb-1')).toBe(true);
      const row = res.body.data.find((r: any) => r.id === 'sb-1');
      expect(row.regimeBreakdown.BULLISH_TREND.count).toBe(1); // genuinely parsed
      expect(row.tradeLog).toBeUndefined(); // summary endpoint deliberately omits the full trade log
      expect(row.promotable).toBe(false);
      expect(row.promotionRejection).toBe('SAME_BAR_CLOSE_NOT_PROMOTABLE');
    });
  });

  describe('GET /api/v2/quant/strategy-backtests/:id', () => {
    it('returns the full real detail (including tradeLog/equityCurve) for one run', async () => {
      const res = await request(app).get('/api/v2/quant/strategy-backtests/sb-1');
      expect(res.status).toBe(200);
      expect(res.body.data.tradeLog).toEqual([{ side: 'BUY' }]);
      expect(res.body.data.equityCurve).toEqual([{ equity: 100000 }]);
      expect(res.body.data.promotable).toBe(false);
      expect(res.body.data.promotionRejection).toBe('SAME_BAR_CLOSE_NOT_PROMOTABLE');
    });

    it('returns a real 404 for an unknown run id', async () => {
      const res = await request(app).get('/api/v2/quant/strategy-backtests/does-not-exist');
      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
    });
  });

  describe('POST /api/v2/quant/strategy-backtests', () => {
    it('validates required fields before touching any real data', async () => {
      const res = await request(app).post('/api/v2/quant/strategy-backtests').send({ symbol: 'X' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('strategyId');
    });

    it('runs a real strategy backtest end-to-end and returns the real result', async () => {
      const dayMs = 24 * 60 * 60 * 1000;
      const startTs = new Date('2023-01-01').getTime();
      const rows: any[] = [];
      let close = 100;
      for (let i = 0; i < 220; i++) {
        const high = close * 1.002, low = close * 0.97;
        rows.push({ id: `V2TREND:1Day:${startTs + i * dayMs}`, symbol: 'V2TREND', timeframe: '1Day', timestamp: startTs + i * dayMs, open: close * 0.99, high, low, close, volume: 500000, source: 'alpaca' });
        close *= 1.008;
      }
      for (const r of rows) await db.insert(schema.ohlcvBars).values(r);

      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.includes('adjustment=raw')) return { ok: true, json: async () => ({ bars: [] }) };
        if (url.includes('adjustment=split')) return { ok: true, json: async () => ({ bars: rows.map(r => ({ t: new Date(r.timestamp).toISOString(), c: r.close })) }) };
        return { ok: true, json: async () => ({}) };
      }));

      const res = await request(app).post('/api/v2/quant/strategy-backtests').send({
        strategyId: 'TREND_FOLLOWING', symbol: 'V2TREND', startDate: '2023-01-01',
        endDate: new Date(startTs + 221 * dayMs).toISOString().split('T')[0],
      });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.status).toBe('COMPLETED');
      expect(res.body.data.strategyId).toBe('TREND_FOLLOWING');
    });

    it('reports a real error (not a 200) for an unknown strategy id', async () => {
      const res = await request(app).post('/api/v2/quant/strategy-backtests').send({
        strategyId: 'NOT_REAL', symbol: 'V2TREND', startDate: '2023-01-01', endDate: '2023-06-01',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Unknown strategy id');
    });

    // E3 (BACKTEST_QUANT_HARDENING_ANALYSIS.md)
    it('passes verboseLogging through and the decision-log route returns real, parsed rows for that run', async () => {
      const dayMs = 24 * 60 * 60 * 1000;
      const startTs = new Date('2023-01-01').getTime();
      const rows: any[] = [];
      let close = 100;
      for (let i = 0; i < 220; i++) {
        const high = close * 1.002, low = close * 0.97;
        rows.push({ id: `V2VERBOSE:1Day:${startTs + i * dayMs}`, symbol: 'V2VERBOSE', timeframe: '1Day', timestamp: startTs + i * dayMs, open: close * 0.99, high, low, close, volume: 500000, source: 'alpaca' });
        close *= 1.008;
      }
      for (const r of rows) await db.insert(schema.ohlcvBars).values(r);

      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.includes('adjustment=raw')) return { ok: true, json: async () => ({ bars: [] }) };
        if (url.includes('adjustment=split')) return { ok: true, json: async () => ({ bars: rows.map(r => ({ t: new Date(r.timestamp).toISOString(), c: r.close })) }) };
        return { ok: true, json: async () => ({}) };
      }));

      const runRes = await request(app).post('/api/v2/quant/strategy-backtests').send({
        strategyId: 'TREND_FOLLOWING', symbol: 'V2VERBOSE', startDate: '2023-01-01',
        endDate: new Date(startTs + 221 * dayMs).toISOString().split('T')[0],
        verboseLogging: true,
      });
      expect(runRes.status).toBe(200);

      const logRes = await request(app).get(`/api/v2/quant/strategy-backtests/${runRes.body.data.id}/decision-log`);
      expect(logRes.status).toBe(200);
      expect(logRes.body.ok).toBe(true);
      expect(logRes.body.data.length).toBeGreaterThan(0);
      for (const row of logRes.body.data) {
        expect(Array.isArray(row.conditionsMet)).toBe(true); // real parsed array, not a JSON string
        expect(Array.isArray(row.conditionsFailed)).toBe(true);
      }
    });

    it('returns an empty array for a run that was not triggered with verboseLogging - honest, not fabricated', async () => {
      const res = await request(app).get('/api/v2/quant/strategy-backtests/sb-1/decision-log');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toEqual([]);
    });
  });

  // E6 (BACKTEST_QUANT_HARDENING_ANALYSIS.md)
  describe('POST /api/v2/quant/strategy-backtests/:id/monte-carlo', () => {
    it('validates required fields', async () => {
      const res = await request(app).post('/api/v2/quant/strategy-backtests/sb-1/monte-carlo').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('initialCapital');
    });

    it('returns a real 404 for an unknown run id', async () => {
      const res = await request(app).post('/api/v2/quant/strategy-backtests/does-not-exist/monte-carlo').send({ initialCapital: 100000, riskPerTradePct: 0.02 });
      expect(res.status).toBe(404);
    });

    it('resamples the real rMultiples from the persisted trade log and always labels the result scenarioAnalysis', async () => {
      const res = await request(app).post('/api/v2/quant/strategy-backtests/sb-1/monte-carlo').send({ initialCapital: 100000, riskPerTradePct: 0.02, simulations: 200 });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.scenarioAnalysis).toBe(true);
      expect(typeof res.body.data.endingEquity.p50).toBe('number');
    });
  });

  describe('Phase 16 honesty routes', () => {
    it('GET /api/v2/markets/canada states live execution is not available', async () => {
      const res = await request(app).get('/api/v2/markets/canada');
      expect(res.status).toBe(200);
      expect(res.body.liveExecution).toBe('NOT_AVAILABLE');
      expect(res.body.banner).toMatch(/NOT AVAILABLE/);
    });

    it('GET /api/v2/desk/lifecycle returns NO HISTORICAL DATA when empty', async () => {
      const res = await request(app).get('/api/v2/desk/lifecycle');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.available).toBe(false);
      expect(res.body.summary).toBe('NO HISTORICAL DATA');
    });
  });
});
