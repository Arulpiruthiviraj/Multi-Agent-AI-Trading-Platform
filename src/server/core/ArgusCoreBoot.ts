/**
 * Engine-only boot path extracted from server.ts.
 * Does not require Express, Vite, React, or WebSocket clients.
 *
 * Boot order invariant (DEF-01): BrokerManager.initialize() before tradingEngine.initialize().
 */
import { AIRouter } from '../ai/AIRouter';
import { armReconciliationBootWarmup } from './startup';
import { installServerLogBuffer } from '../services/ServerLogBuffer';
import { BrokerManager } from '../../brokers/BrokerManager';
import { tradingEngine } from '../engines/TradingEngine';
import { alertingService } from '../services/AlertingService';
import { marketDataWorker } from '../services/MarketDataWorker';
import { authorizeMarketDataWebSocket } from './marketDataWsOwnership';
import { db, sqliteDb } from '../db';
import * as schema from '../db/schema';

export interface ArgusCoreBootResult {
  settingsRow: typeof schema.settings.$inferSelect | null;
}

function ensureSessionsTableExists(): void {
  try {
    sqliteDb.exec(`CREATE TABLE IF NOT EXISTS sessions (
      session_token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`);
  } catch (e) {
    console.warn('Could not ensure sessions table exists:', e);
  }
}

function ensureDailyTradingSummaryTableExists(): void {
  try {
    sqliteDb.exec(`CREATE TABLE IF NOT EXISTS daily_trading_summary (
      date TEXT PRIMARY KEY,
      total_trades INTEGER DEFAULT 0,
      total_volume REAL DEFAULT 0,
      realized_pnl REAL DEFAULT 0,
      unrealized_pnl REAL DEFAULT 0,
      allocated_amount REAL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`);
  } catch (e) {
    console.warn('Could not create daily trading summary table:', e);
  }
}

let coreBooted = false;

export function isArgusCoreBooted(): boolean {
  return coreBooted;
}

/** Test-only reset — does not tear down singletons. */
export function resetArgusCoreBootedForTests(): void {
  coreBooted = false;
}

/**
 * Initialize the authoritative trading spine and boot workers.
 * Safe to call once per process; subsequent calls are no-ops.
 */
export async function bootArgusCore(): Promise<ArgusCoreBootResult> {
  if (coreBooted) {
    const existing = await db.select().from(schema.settings).limit(1);
    return { settingsRow: existing[0] ?? null };
  }

  armReconciliationBootWarmup();
  installServerLogBuffer();

  // Durable EventStore listeners must attach before idea agents emit (decision lifecycle → event_traces).
  await import('./EventStore');

  const { loadInterruptedSessionMarker, beginRuntimeSession, startSessionRecoveryListeners } =
    await import('./sessionRecovery');
  loadInterruptedSessionMarker();
  startSessionRecoveryListeners();

  await AIRouter.getInstance().initialize();

  // DEF-01: real broker before TradingEngine (Autobot restore may start reconciliation).
  await BrokerManager.getInstance().initialize();
  await tradingEngine.initialize();
  beginRuntimeSession();

  alertingService.start();

  let settings = await db.select().from(schema.settings).limit(1);
  if (settings.length === 0) {
    await db.insert(schema.settings).values({
      tradingMode: 'PAPER',
      riskLevel: 'Medium',
      budget: 50000,
      strategy: 'ADAPTIVE_MULTI_STRATEGY',
      maxTradeSize: 3000,
      dailyLossLimit: 5000,
      takeProfitPct: 15,
      trailingStopPct: 5,
      minAiConfidence: 75,
      adversarialDebateMode: true,
    });
    settings = await db.select().from(schema.settings).limit(1);
  }

  try {
    const { hydrateRuntimeConfigFromDb } = await import('../config/effectiveRuntimeConfig');
    const n = await hydrateRuntimeConfigFromDb();
    console.log(
      `[EffectiveRuntimeConfig] Hydrated ${n} Settings overlay(s) from config_overrides (.env remains bootstrap; overlays win).`,
    );
  } catch (e: any) {
    console.warn(`[EffectiveRuntimeConfig] Hydrate failed (env/defaults still apply): ${e.message}`);
  }

  try {
    authorizeMarketDataWebSocket('ArgusCoreBoot');
    marketDataWorker.start();
    console.log(
      '[MarketDataWorker] Started at boot (independent of Autobot). RiskEngine data_freshness still requires a fresh tick.',
    );
  } catch (e: any) {
    console.warn(`[MarketDataWorker] Boot start failed: ${e.message}`);
  }

  try {
    const { portfolioReconciliationWorker } = await import('../services/PortfolioReconciliation');
    portfolioReconciliationWorker.start();
    console.log(
      '[PortfolioReconciliation] Started at boot (independent of Autobot). In-process RECONCILIATION_MATCH releases interrupted-session entry hold; does not auto-resume TRADING_PAUSED or enable Autobot.',
    );
  } catch (e: any) {
    console.warn(`[PortfolioReconciliation] Boot start failed: ${e.message}`);
  }

  try {
    const { newsEngine } = await import('../news/NewsEngine');
    newsEngine.start();
    console.log(
      '[NewsEngine] Started at boot (independent of Autobot / market clock). 24/7 ingest + adaptive cadence; TRADE_IDEA_GENERATED stays desk/Autobot-gated; orders still RiskEngine market_hours gated.',
    );
  } catch (e: any) {
    console.warn(`[NewsEngine] Boot start failed: ${e.message}`);
  }

  try {
    const { kronosEngine } = await import('../engines/kronos/KronosEngine');
    const { kronosForecastAgent } = await import('../services/KronosForecastAgent');
    const { isPipelineAgentEnabled } = await import('./pipelineAgentGate');
    await kronosEngine.initialize();
    if (isPipelineAgentEnabled('KronosEngine')) {
      kronosForecastAgent.start();
      console.log(
        '[KronosForecastAgent] Started at boot (independent of Autobot). Research/UI forecasts call Chronos :8008 when healthy; TRADE_IDEA_GENERATED stays Autobot/session-gated and fail-closed when /health is down.',
      );
    } else {
      console.log('[KronosForecastAgent] Pipeline agent disabled — not listening for MARKET_DATA.');
    }
  } catch (e: any) {
    console.warn(`[KronosForecastAgent] Boot start failed: ${e.message}`);
  }

  try {
    const { opportunityDiscoveryWorker } = await import('../continuous/OpportunityDiscovery');
    opportunityDiscoveryWorker.start();
  } catch (e: any) {
    console.warn(`[OpportunityDiscovery] Boot start failed: ${e.message}`);
  }

  try {
    const { opportunityScreenerWorker } = await import('../continuous/OpportunityScreener');
    opportunityScreenerWorker.start();
  } catch (e: any) {
    console.warn(`[OpportunityScreener] Boot start failed: ${e.message}`);
  }

  try {
    const { autoTradeScheduler } = await import('../services/AutoTradeScheduler');
    autoTradeScheduler.start();
    console.log(
      '[AutoTradeScheduler] Started at boot (independent of Autobot state; no-op unless settings.autoTradeScheduleEnabled is true).',
    );
  } catch (e: any) {
    console.warn(`[AutoTradeScheduler] Boot start failed: ${e.message}`);
  }

  try {
    const { strategyEngineShadowRunner } = await import('../services/StrategyEngineShadowRunner');
    strategyEngineShadowRunner.start();
    console.log(
      '[StrategyEngineShadowRunner] Started at boot (isolated, optional; no-op unless settings.strategyEngineEnabled is true and mode is SHADOW/ANALYSIS_ONLY. Never places or influences a real order.)',
    );
  } catch (e: any) {
    console.warn(`[StrategyEngineShadowRunner] Boot start failed: ${e.message}`);
  }

  try {
    const { campaignTracker } = await import('../services/CampaignTracker');
    campaignTracker.start();
  } catch (e: any) {
    console.warn(`[CampaignTracker] Boot start failed: ${e.message}`);
  }

  try {
    const { firstFillForensicCheckpoint } = await import('../services/FirstFillForensicCheckpoint');
    firstFillForensicCheckpoint.start();
  } catch (e: any) {
    console.warn(`[FirstFillForensicCheckpoint] Boot start failed: ${e.message}`);
  }

  try {
    const { quantCoreBridge } = await import('../services/QuantCoreBridge');
    quantCoreBridge.start(); // no-op unless QUANT_JAVA_CORE_ENABLED=true; advisory shadow-only until a separate live-ideas flag is also set
  } catch (e: any) {
    console.warn(`[QuantCoreBridge] Boot start failed: ${e.message}`);
  }

  try {
    // Phase 2 of the Java engine activation plan - same gating flag/pattern as quantCoreBridge
    // just above (no-op unless QUANT_JAVA_CORE_ENABLED=true). Gives GARCH/HMM/factor-composite a
    // real periodic consumer (QUANT_ADVISORY_ANALYSIS_COMPLETED); still advisory-only, not wired
    // into ChiefTrader/EvidenceAggregator - see JavaQuantAdvisoryService.ts's own header.
    const { javaQuantAdvisoryService } = await import('../services/JavaQuantAdvisoryService');
    javaQuantAdvisoryService.start();
  } catch (e: any) {
    console.warn(`[JavaQuantAdvisoryService] Boot start failed: ${e.message}`);
  }

  try {
    const { modelRuntimeManager } = await import('../ai/ModelRuntimeManager');
    const models = await modelRuntimeManager.startAndProbe();
    for (const m of models) {
      const line =
        m.health === 'READY'
          ? `[ModelRuntime] ${m.modelId.padEnd(16)} READY  ${m.detail || ''}`
          : `[ModelRuntime] ${m.modelId.padEnd(16)} ${m.health}  Reason: ${m.detail || 'unknown'}  Action: ${m.action || 'none'}`;
      if (m.health === 'READY' || m.health === 'DISABLED') console.log(line);
      else console.warn(line);
    }
  } catch (e: any) {
    console.warn(`[ModelRuntime] Probe failed (Argus remains usable): ${e.message}`);
  }

  const row = settings[0];
  if (row) {
    Object.assign(tradingEngine.state, {
      tradingMode: row.tradingMode,
      riskLevel: row.riskLevel,
      budget: row.budget,
      strategy: row.strategy,
      maxTradeSize: row.maxTradeSize,
      dailyLossLimit: row.dailyLossLimit,
      takeProfitPct: row.takeProfitPct,
      trailingStopPct: row.trailingStopPct,
      minAiConfidence: row.minAiConfidence,
      adversarialDebateMode: row.adversarialDebateMode,
    });
  }

  ensureSessionsTableExists();
  ensureDailyTradingSummaryTableExists();

  console.log('Argus Core boot complete — DB initialized and state loaded.');
  coreBooted = true;
  return { settingsRow: row ?? null };
}
