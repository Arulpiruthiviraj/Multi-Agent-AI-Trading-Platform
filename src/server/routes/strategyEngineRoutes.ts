/**
 * ==========================================================
 * Module: routes/strategyEngineRoutes
 *
 * Purpose:
 * REST surface for the isolated Strategy Engine (src/server/strategiesEngine/). Mirrors
 * configRoutes.ts's conventions (allowlist-validated settings writes, try/catch -> 500, explicit
 * 400s for bad input). NO endpoint in this file imports or calls OrderManagement, BrokerManager,
 * or RiskEngine - StrategyEngineShadowRunner.safety.test.ts's static grep additionally covers this
 * file's directory tree to keep that guarantee from silently regressing.
 * ==========================================================
 */
import { Router } from 'express';
import { db } from '../db';
import * as schema from '../db/schema';
import {
  defaultRegistry, findStrategies, getStrategy, getEngineStats, generateStrategies,
} from '../strategiesEngine/index';
import { runBacktest } from '../strategiesEngine/backtest/runBacktest';
import { promoteEvidence, EvidenceState, EVIDENCE_LADDER } from '../strategiesEngine/core/evidence';
import { withEvidenceState } from '../strategiesEngine/core/createStrategy';
import { rankStrategies, RankingCriterion } from '../strategiesEngine/core/StrategyPerformance';
import { randomUUID } from 'crypto';

export const strategyEngineRouter = Router();

const REAL_MODES = ['OFF', 'SHADOW', 'ANALYSIS_ONLY']; // only these are implemented in this pass - see the implementation report

strategyEngineRouter.get('/status', async (req, res) => {
  try {
    const row = (await db.select().from(schema.settings).limit(1))[0];
    res.json({
      enabled: row?.strategyEngineEnabled ?? false,
      mode: row?.strategyEngineMode ?? 'OFF',
      activeIds: row ? JSON.parse(row.strategyEngineActiveIdsJson || '[]') : [],
      maxActive: row?.strategyEngineMaxActive ?? 25,
      minConfidence: row?.strategyEngineMinConfidence ?? 0.6,
      stats: getEngineStats(),
      note: 'This subsystem never places or influences a real order at any setting value - see STRATEGIES_ENGINE.md and ARGUS_STRATEGY_ENGINE_IMPLEMENTATION.md.',
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

strategyEngineRouter.post('/enable', async (req, res) => {
  try {
    await db.update(schema.settings).set({ strategyEngineEnabled: true }).run();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

strategyEngineRouter.post('/disable', async (req, res) => {
  try {
    await db.update(schema.settings).set({ strategyEngineEnabled: false }).run();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

strategyEngineRouter.post('/mode', async (req, res) => {
  try {
    const mode = req.body?.mode;
    if (!REAL_MODES.includes(mode)) {
      return res.status(400).json({
        ok: false,
        error: `Mode ${JSON.stringify(mode)} is not implemented in this pass. Real modes: ${REAL_MODES.join(', ')}. SIGNAL_ADVISORY/CONSENSUS_PARTICIPANT/PAPER_ONLY/LIVE_ELIGIBLE are reserved for a future phase and are deliberately rejected here rather than silently accepted with no real behavior.`,
      });
    }
    await db.update(schema.settings).set({ strategyEngineMode: mode }).run();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

strategyEngineRouter.post('/active-ids', async (req, res) => {
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.every((x: unknown) => typeof x === 'string')) {
      return res.status(400).json({ ok: false, error: 'body.ids must be a string[]' });
    }
    const unknown = ids.filter((id: string) => !defaultRegistry.exists(id));
    if (unknown.length > 0) {
      return res.status(400).json({ ok: false, error: `Unknown strategy id(s), not registered: ${unknown.join(', ')}` });
    }
    await db.update(schema.settings).set({ strategyEngineActiveIdsJson: JSON.stringify(ids) }).run();
    res.json({ ok: true, activeIds: ids });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

strategyEngineRouter.get('/strategies', (req, res) => {
  try {
    const family = typeof req.query.family === 'string' ? (req.query.family as any) : undefined;
    const origin = typeof req.query.origin === 'string' ? (req.query.origin as any) : undefined;
    const limit = Math.min(500, Number(req.query.limit) || 100);
    const results = findStrategies({ family, origin }).slice(0, limit);
    res.json({ count: results.length, totalRegistered: defaultRegistry.count(), strategies: results });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

strategyEngineRouter.get('/strategies/:id', (req, res) => {
  const strategy = getStrategy(req.params.id);
  if (!strategy) return res.status(404).json({ error: 'Not found in the current registry.' });
  res.json(strategy);
});

strategyEngineRouter.get('/strategies/:id/signals', async (req, res) => {
  try {
    const { eq } = await import('drizzle-orm');
    const rows = await db.select().from(schema.strategyEngineSignals)
      .where(eq(schema.strategyEngineSignals.strategyId, req.params.id))
      .limit(Math.min(500, Number(req.query.limit) || 100));
    res.json({ strategyId: req.params.id, count: rows.length, signals: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

strategyEngineRouter.get('/strategies/:id/backtests', async (req, res) => {
  try {
    const { eq } = await import('drizzle-orm');
    const rows = await db.select().from(schema.strategyEngineBacktestRuns)
      .where(eq(schema.strategyEngineBacktestRuns.strategyId, req.params.id))
      .limit(Math.min(200, Number(req.query.limit) || 50));
    res.json({ strategyId: req.params.id, count: rows.length, runs: rows.map((r: any) => ({ ...r, metrics: JSON.parse(r.metricsJson) })) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

strategyEngineRouter.post('/strategies/backtest', async (req, res) => {
  try {
    const { id, symbol, timeframe, startMs, endMs } = req.body || {};
    if (typeof id !== 'string' || typeof symbol !== 'string' || typeof timeframe !== 'string') {
      return res.status(400).json({ ok: false, error: 'id, symbol, timeframe are required strings.' });
    }
    const strategy = getStrategy(id);
    if (!strategy) return res.status(404).json({ ok: false, error: `Strategy ${id} not found in the current registry.` });
    const end = Number(endMs) || Date.now();
    const start = Number(startMs) || (end - 400 * 24 * 60 * 60 * 1000);

    const result = await runBacktest({ strategy, symbol, timeframe: timeframe as any, startMs: start, endMs: end });

    const runId = randomUUID();
    await db.insert(schema.strategyEngineBacktestRuns).values({
      id: runId,
      strategyId: strategy.id,
      strategyName: strategy.name,
      symbol,
      timeframe,
      periodStart: result.performance.periodStart,
      periodEnd: result.performance.periodEnd,
      metricsJson: JSON.stringify(result.performance),
      datasetHash: result.datasetHash,
      createdAt: new Date().toISOString(),
    }).run();

    res.json({ ok: true, runId, barsUsed: result.barsUsed, performance: result.performance, datasetHash: result.datasetHash, tradeCount: result.trades.length });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e.message }); // real backtest failures (no data, no credentials) are client-actionable, not server bugs
  }
});

strategyEngineRouter.get('/strategies/rankings', async (req, res) => {
  try {
    const criterion = (req.query.criterion as RankingCriterion) || 'PROFIT_FACTOR';
    const { desc } = await import('drizzle-orm');
    const rows = await db.select().from(schema.strategyEngineBacktestRuns).orderBy(desc(schema.strategyEngineBacktestRuns.createdAt)).limit(2000);
    // Most recent real run per strategy - never averages/blends multiple runs into a fabricated composite.
    const latestByStrategy = new Map<string, any>();
    for (const row of rows) {
      if (!latestByStrategy.has(row.strategyId)) latestByStrategy.set(row.strategyId, row);
    }
    const inputs = Array.from(latestByStrategy.values()).map((row: any) => ({
      strategyId: row.strategyId,
      performance: JSON.parse(row.metricsJson),
    }));
    const ranked = rankStrategies(inputs, criterion);
    res.json({ criterion, count: ranked.length, rankings: ranked });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

strategyEngineRouter.post('/strategies/generate', (req, res) => {
  try {
    const limit = Math.min(5000, Number(req.body?.limit) || 500); // hard cap - never generate the full 10,000+ synchronously in one request
    const result = generateStrategies({ limit });
    res.json({ ok: true, generatedCount: result.generated.length, totalSpaceSize: result.totalSpaceSize, truncated: result.truncated, skipped: result.skipped.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

strategyEngineRouter.post('/strategies/:id/promote', async (req, res) => {
  try {
    const strategy = getStrategy(req.params.id);
    if (!strategy) return res.status(404).json({ ok: false, error: 'Not found in the current registry.' });
    const target = req.body?.target as EvidenceState;
    const reason = req.body?.reason;
    const actor = typeof req.body?.actor === 'string' && req.body.actor.trim() ? req.body.actor : 'system';
    if (!EVIDENCE_LADDER.includes(target)) {
      return res.status(400).json({ ok: false, error: `target must be one of: ${EVIDENCE_LADDER.join(', ')}` });
    }
    const result = promoteEvidence(strategy.evidenceState, target, reason);
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }
    withEvidenceState(strategy, result.newState); // real object returned but not persisted in-place - the registry entry is intentionally immutable; a real DB-backed override table is a documented next step, not faked here
    await db.insert(schema.strategyEnginePromotions).values({
      id: randomUUID(),
      strategyId: strategy.id,
      fromState: strategy.evidenceState,
      toState: result.newState,
      evidenceRefTable: null,
      evidenceRefId: null,
      reason,
      actor,
      createdAt: new Date().toISOString(),
    }).run();
    res.json({ ok: true, from: strategy.evidenceState, to: result.newState });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

strategyEngineRouter.get('/strategies/:id/promotions', async (req, res) => {
  try {
    const { eq, desc } = await import('drizzle-orm');
    const rows = await db.select().from(schema.strategyEnginePromotions)
      .where(eq(schema.strategyEnginePromotions.strategyId, req.params.id))
      .orderBy(desc(schema.strategyEnginePromotions.createdAt));
    res.json({ strategyId: req.params.id, count: rows.length, promotions: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
