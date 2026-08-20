/**
 * Stable runtime API — adapters call these routes; no trading logic here.
 */
import { Router } from 'express';
import { argusRuntime } from '../core/ArgusRuntime';
import { argusApplication } from '../app/ArgusApplication';
import { tradingLimiter } from '../core/RateLimiters';
import { marketDataWorker } from '../services/MarketDataWorker';
import { evaluateLiveReadiness } from '../core/liveReadinessEngine';

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

runtimeRouter.get('/health', (_req, res) => {
  const health = argusRuntime.health();
  res.status(health.ok ? 200 : 503).json({
    ok: health.ok,
    health,
    live: evaluateLiveReadiness().result,
  });
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

runtimeRouter.get('/trades', async (_req, res) => {
  const rows = await argusApplication.recentTrades(100);
  res.json({ ok: true, trades: rows, live: 'NO-GO' });
});

runtimeRouter.get('/orders', async (_req, res) => {
  const rows = await argusApplication.recentTrades(100);
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
