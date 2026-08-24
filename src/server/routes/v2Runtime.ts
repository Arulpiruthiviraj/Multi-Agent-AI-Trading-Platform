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
