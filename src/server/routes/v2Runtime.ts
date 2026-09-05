/**
 * Stable runtime API — adapters call these routes; no trading logic here.
 */
import { Router } from 'express';
import { argusRuntime } from '../core/ArgusRuntime';
import { argusApplication } from '../app/ArgusApplication';
import { tradingLimiter } from '../core/RateLimiters';
import { marketDataWorker } from '../services/MarketDataWorker';
import { evaluateLiveReadiness } from '../core/liveReadinessEngine';
import { BrokerManager } from '../../brokers/BrokerManager';
import { getAIProviderHealthSnapshot, runAIProviderHealthCheckNow } from '../ai/AIProviderHealthCheck';
import { getTradingReadinessSnapshot, renderTradingReadinessTree } from '../core/TradingReadinessGate';
import { getTradingSessionReport, renderTradingSessionReport } from '../core/tradingSessionReport';
import { allowsNewEntryIdeas } from '../core/sessionRecovery';

export const runtimeRouter = Router();

runtimeRouter.get('/status', (_req, res) => {
  const appStatus = argusRuntime.status();
  res.json({
    ok: true,
    runtime: appStatus.runtime,
    autobot: appStatus.autobot,
    system: appStatus.system,
    consistent: appStatus.consistent,
    liveReadiness: appStatus.liveReadiness,
    pipelineAgents: appStatus.pipelineAgents,
    live: 'NO-GO',
  });
});

runtimeRouter.get('/health', async (_req, res) => {
  const health = argusRuntime.health();
  let activeBroker: {
    id: string;
    name: string;
    paperTradingOnly: boolean;
    connection?: Record<string, unknown>;
  } | undefined;
  let ibkrPaths: Awaited<ReturnType<BrokerManager['getIbkrPathStatus']>> | undefined;
  try {
    // Reporting only — does not place orders. OMS + RiskEngine remain sole execution gatekeepers.
    const mgr = BrokerManager.getInstance();
    const b = mgr.getActiveBroker();
    activeBroker = {
      id: b.id,
      name: b.name,
      paperTradingOnly: process.env.PAPER_TRADING_ONLY === 'true',
    };
    if (typeof (b as any).getConnectionSnapshot === 'function') {
      activeBroker.connection = (b as any).getConnectionSnapshot();
    }
    ibkrPaths = await mgr.getIbkrPathStatus();
  } catch {
    activeBroker = undefined;
    ibkrPaths = undefined;
  }
  // Zero-Trade Forensic Audit follow-up: process-alive != decision-quality-healthy. This summary
  // deliberately sits next to (not folded into) `health` so "CLI is active" can never read as
  // "AI/decision layer is fine" - full per-provider detail lives at GET /api/v2/ai/providers/health.
  let aiProviderHealth: { healthy: number; total: number; statuses: Record<string, number> } | undefined;
  try {
    const snapshot = await getAIProviderHealthSnapshot();
    const statuses: Record<string, number> = {};
    for (const p of snapshot) statuses[p.status] = (statuses[p.status] ?? 0) + 1;
    aiProviderHealth = { healthy: snapshot.filter(p => p.status === 'HEALTHY').length, total: snapshot.length, statuses };
  } catch {
    aiProviderHealth = undefined;
  }
  res.status(health.ok ? 200 : 503).json({
    ok: health.ok,
    health,
    activeBroker,
    ibkrPaths,
    aiProviderHealth,
    live: evaluateLiveReadiness().result,
  });
});

/** Full per-provider AI health detail (CONFIG + AUTH + RUNTIME tiers). Never returns a raw key. */
runtimeRouter.get('/ai/providers/health', async (_req, res) => {
  try {
    const providers = await getAIProviderHealthSnapshot();
    res.json({ ok: true, providers, live: 'NO-GO' });
  } catch (e: unknown) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Trading Readiness Gate - distinguishes "process alive" from "trading pipeline ready"
 * (Zero-Trade Forensic Audit follow-up). Read-only diagnostic; never arms LIVE, never toggles
 * Autobot, never places/blocks an order itself - see TradingReadinessGate.ts's own header.
 */
runtimeRouter.get('/trading-readiness', async (req, res) => {
  try {
    const snapshot = await getTradingReadinessSnapshot();
    if (req.query.format === 'text') {
      res.type('text/plain').send(renderTradingReadinessTree(snapshot));
      return;
    }
    res.json({ ok: true, ...snapshot, live: 'NO-GO' });
  } catch (e: unknown) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Pre-market/market-open operator observability report (2026-08-24 readiness audit, Part 10).
 * Read-only, real counts only, scoped to the current real exchange trading day - never mixes
 * organic PAPER/LIVE activity with REPLAY/BACKTEST/SIMULATION (see tradingSessionReport.ts's own
 * header and the executionContextBreakdown field).
 */
runtimeRouter.get('/trading-session-report', async (req, res) => {
  try {
    const report = await getTradingSessionReport({
      activeSymbols: marketDataWorker.getActiveSymbols().length,
      maxSymbols: marketDataWorker.getEffectiveStreamingCap(),
      interruptedSessionHold: !allowsNewEntryIdeas(),
    });
    if (req.query.format === 'text') {
      res.type('text/plain').send(renderTradingSessionReport(report));
      return;
    }
    res.json({ ok: true, ...report, live: 'NO-GO' });
  } catch (e: unknown) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/** On-demand "Test Provider" trigger - runs a real, minimal auth+chat probe now (optionally for
 *  one provider via ?providerId=) rather than waiting for the periodic monitor's next tick. */
runtimeRouter.post('/ai/providers/health/check', tradingLimiter, async (req, res) => {
  try {
    const providerId = typeof req.body?.providerId === 'string' ? req.body.providerId : undefined;
    const providers = await runAIProviderHealthCheckNow(providerId);
    res.json({ ok: true, providers, live: 'NO-GO' });
  } catch (e: unknown) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/** Idempotent core boot — safe if server already called bootCore at startup. */
runtimeRouter.post('/start', tradingLimiter, async (_req, res) => {
  try {
    await argusRuntime.start();
    res.json({ ok: true, runtime: argusRuntime.getSnapshot(), health: argusRuntime.health() });
  } catch (e: unknown) {
    res.status(500).json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      runtime: argusRuntime.getSnapshot(),
    });
  }
});

/** Safe stop: pause trading + disable Autobot — does NOT kill HTTP process. */
runtimeRouter.post('/stop', tradingLimiter, async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'API runtime stop';
  const actor = typeof req.body?.actor === 'string' ? req.body.actor : 'api/v2/runtime/stop';
  const result = await argusRuntime.stop({ reason, actor });
  if (!result.ok) {
    return res.status(500).json({ ok: false, error: result.error, runtime: argusRuntime.getSnapshot() });
  }
  res.json({ ok: true, runtime: argusRuntime.getSnapshot(), health: argusRuntime.health() });
});

runtimeRouter.get('/market/status', (_req, res) => {
  res.json({ ok: true, feed: marketDataWorker.getFeedStatus(), live: 'NO-GO' });
});

// Phase 4J (Session Lifecycle persistence, 2026-08-27) - real, in-process snapshot plus recent
// persisted history, so a restart's recovered prior-state context is externally observable.
runtimeRouter.get('/session-lifecycle', async (req, res) => {
  try {
    const { sessionLifecycleWorker, getRefinedSnapshot } = await import('../premarket/SessionLifecycle');
    const { db } = await import('../db');
    const { sessionLifecycleSnapshots } = await import('../db/schema');
    const { desc } = await import('drizzle-orm');
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
    const history = await db.select().from(sessionLifecycleSnapshots)
      .orderBy(desc(sessionLifecycleSnapshots.evaluatedAt))
      .limit(limit);
    // Session-Aware Trading Architecture Phase 1 (2026-09-05): `current` stays the worker's own
    // deterministic snapshot (unchanged contract); `refined` additionally reflects real TradePlan
    // state (PLAN_BUILDING/PLAN_READY/OPEN_REVALIDATION) - see SessionLifecycle.ts's
    // getRefinedSnapshot() doc comment for why this is a separate read, not a mutation of `current`.
    const current = sessionLifecycleWorker.getSnapshot();
    const refined = await getRefinedSnapshot(current);
    res.json({ ok: true, current, refined, history });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

runtimeRouter.get('/risk/status', (_req, res) => {
  const health = argusRuntime.health();
  res.json({
    ok: true,
    tradingState: health.tradingState,
    emergencyStopActive: health.emergencyStopActive,
    safeMode: health.safeMode,
    liveReadiness: health.liveReadiness,
    live: 'NO-GO',
  });
});

// Phase 3F (Risk Center) - real 24-gate breakdown per recent risk assessment, read-only.
// risk_gate_results records EVERY gate even after the first failure (CLAUDE.md: "every gate
// recorded even after first failure") - this route surfaces exactly those rows, never a
// synthesized/assumed pass. No frontend override path exists or should exist here.
runtimeRouter.get('/risk/recent-assessments', async (req, res) => {
  try {
    const { db } = await import('../db');
    const { riskAssessments, riskGateResults } = await import('../db/schema');
    const { desc, eq, inArray } = await import('drizzle-orm');
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));

    const assessments = await db.select().from(riskAssessments)
      .orderBy(desc(riskAssessments.createdAt))
      .limit(limit);
    if (assessments.length === 0) {
      return res.json({ ok: true, count: 0, assessments: [] });
    }

    const traceIds = assessments.map((a) => a.traceId);
    const gateRows = await db.select().from(riskGateResults)
      .where(inArray(riskGateResults.traceId, traceIds))
      .orderBy(riskGateResults.sequence);

    const gatesByTrace = new Map<string, typeof gateRows>();
    for (const g of gateRows) {
      const list = gatesByTrace.get(g.traceId) ?? [];
      list.push(g);
      gatesByTrace.set(g.traceId, list);
    }

    const result = assessments.map((a) => ({
      traceId: a.traceId,
      symbol: a.symbol,
      side: a.side,
      approved: a.approved,
      rejectionGate: a.rejectionGate,
      accountEquity: a.accountEquity,
      createdAt: a.createdAt,
      gates: (gatesByTrace.get(a.traceId) ?? []).map((g) => ({
        gateName: g.gateName,
        sequence: g.sequence,
        passed: g.passed,
        detail: g.detail,
      })),
    }));

    res.json({ ok: true, count: result.length, assessments: result });
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

runtimeRouter.post('/trading/enable', tradingLimiter, async (req, res) => {
  const result = await argusApplication.enableTrading(req.body ?? {});
  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error, status: argusApplication.status() });
  }
  res.json({ ok: true, status: argusApplication.status() });
});

runtimeRouter.post('/trading/disable', tradingLimiter, async (_req, res) => {
  const result = await argusApplication.disableTrading();
  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error, status: argusApplication.status() });
  }
  res.json({ ok: true, status: argusApplication.status() });
});

runtimeRouter.get('/portfolio', async (_req, res) => {
  const holdings = await argusApplication.positions();
  res.json({ ok: true, portfolio: holdings, live: 'NO-GO' });
});

runtimeRouter.get('/trades', async (req, res) => {
  let liveId: string | null = null;
  try {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    liveId = BrokerManager.getInstance().getActiveBroker()?.id ?? null;
  } catch { /* */ }
  const brokerId = typeof req.query.brokerId === 'string' ? req.query.brokerId : liveId;
  const rows = await argusApplication.recentTrades(100, brokerId);
  res.json({ ok: true, trades: rows, live: 'NO-GO' });
});

runtimeRouter.get('/orders', async (req, res) => {
  let liveId: string | null = null;
  try {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    liveId = BrokerManager.getInstance().getActiveBroker()?.id ?? null;
  } catch { /* */ }
  const brokerId = typeof req.query.brokerId === 'string' ? req.query.brokerId : liveId;
  const rows = await argusApplication.recentTrades(100, brokerId);
  res.json({
    ok: true,
    orders: rows,
    note: 'Recent trade ledger rows; full OMS order book not yet exposed on this alias.',
    live: 'NO-GO',
  });
});

runtimeRouter.get('/config', (_req, res) => {
  res.json({ ok: true, runtime: argusRuntime.getSnapshot(), live: 'NO-GO' });
});
