import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';

/**
 * Real integration test (isolated temp SQLite DB, real Express router via supertest) for
 * GET /api/v2/agents/efficiency - the real replacement for TradeEfficiencyReport.tsx's 5
 * hardcoded, fictional "strategies" (Momentum/Mean Revert/News Arb/Order Flow/Macro) whose
 * slippage/latency values were client-side Date.now()-jittered noise, never backed by any real
 * measurement. Proves the route aggregates real agent_performance_stats.winRate and real
 * agent_predictions.latencyMs per real agent, and honestly reports null (not 0 or a fabricated
 * figure) for an agent with no real logged latency (TechnicalAgent/KronosForecastAgent never
 * make an LLM call, so agent_predictions.latencyMs is genuinely null for them).
 */
describe('GET /api/v2/agents/efficiency', { timeout: 30_000 }, () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_v2efficiency_${Date.now()}_${process.pid}.db`);
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

  it('honestly reports available:false when only ChiefTraderAgent\'s placeholder weight rows exist (totalPredictions:0), never a real evaluated win rate', async () => {
    // ChiefTraderAgent.syncWeights() seeds a placeholder agent_performance_stats row for every
    // agent (fire-and-forget, at singleton construction time) purely so consensus has an initial
    // weight to use - real production rows look exactly like this until ReflectionEngine scores
    // a real outcome. The route must not mistake that placeholder for a real win rate.
    const res = await request(app).get('/api/v2/agents/efficiency');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.available).toBe(false);
    expect(res.body.data).toEqual([]);
  });

  it('computes a real win rate from agent_performance_stats and a real avg latency from agent_predictions', async () => {
    // NewsAgent's placeholder row already exists (see above) - update it in place, exactly as
    // ReflectionEngine's own real evaluateAgents() does once it has a real outcome to score.
    await db.update(schema.agentPerformanceStats)
      .set({ totalPredictions: 20, correctPredictions: 8, winRate: 0.4, lastEvaluated: new Date().toISOString() })
      .where(eq(schema.agentPerformanceStats.agentName, 'NewsAgent'));
    await db.insert(schema.agentPredictions).values([
      { id: 'p1', agentName: 'NewsAgent', symbol: 'AAPL', prediction: 'BUY', confidence: 0.7, reasoning: 'x', timestamp: new Date().toISOString(), latencyMs: 1000 },
      { id: 'p2', agentName: 'NewsAgent', symbol: 'MSFT', prediction: 'SELL', confidence: 0.6, reasoning: 'x', timestamp: new Date().toISOString(), latencyMs: 2000 },
      // TechnicalAgent never calls an LLM - latencyMs is genuinely null, matching real production rows.
      { id: 'p3', agentName: 'TechnicalAgent', symbol: 'AAPL', prediction: 'BUY', confidence: 0.8, reasoning: 'x', timestamp: new Date().toISOString(), latencyMs: null },
      // A non-real agent name must never contaminate the real five-agent aggregation.
      { id: 'p4', agentName: 'SentimentAgent', symbol: 'AAPL', prediction: 'BUY', confidence: 0.9, reasoning: 'x', timestamp: new Date().toISOString(), latencyMs: 50 },
    ]);

    const res = await request(app).get('/api/v2/agents/efficiency');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.available).toBe(true);

    const news = res.body.data.find((d: any) => d.agentName === 'NewsAgent');
    expect(news.winRate).toBe(40); // 0.4 -> 40%
    expect(news.avgLatencyMs).toBe(1500); // (1000+2000)/2

    const technical = res.body.data.find((d: any) => d.agentName === 'TechnicalAgent');
    expect(technical.winRate).toBeNull(); // no agent_performance_stats row for it
    expect(technical.avgLatencyMs).toBeNull(); // no real latency ever logged for a deterministic agent

    expect(res.body.data.map((d: any) => d.agentName)).toEqual([
      'TechnicalAgent', 'NewsAgent', 'FundamentalAgent', 'MacroAgent', 'KronosForecastAgent',
    ]);
  });
});
