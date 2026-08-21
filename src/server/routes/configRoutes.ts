import { v4 as uuidv4 } from 'uuid';
import { ConfigItemStatus, WizardStatusResponse } from '../types/wizardStatus';
import { networkEndpoints } from '../config/networkEndpoints';
import { tradingSafety } from '../config/tradingSafety';

interface ProviderStatus {
  provider: string;
  isConfigured: boolean;
  source: 'env' | 'database' | null;
}

/** Data providers read only from process.env in this codebase - there is no
 * DB table/route that persists these keys today, so "db" is never a valid
 * source for this category (kept honest rather than implying one exists). */
const DATA_PROVIDER_ENV_MAP: Record<string, string> = {
  AlphaVantage: 'ALPHAVANTAGE_API_KEY',
  Polygon:      'POLYGON_API_KEY',
  FMP:          'FMP_API_KEY',
  Finnhub:      'FINNHUB_API_KEY',
};

const AI_PROVIDER_ENV_MAP: Record<string, string> = {
  Gemini:     'GEMINI_API_KEY',
  OpenAI:     'OPENAI_API_KEY',
  Claude:     'ANTHROPIC_API_KEY',
  DeepSeek:   'DEEPSEEK_API_KEY',
  Groq:       'GROQ_API_KEY',
  Grok:       'GROK_API_KEY',
  Kimi:       'KIMI_API_KEY',
  OpenRouter: 'OPENROUTER_API_KEY',
  Mistral:    'MISTRAL_API_KEY',
  NVIDIA:     'NVIDIA_API_KEY',
};

/** Alternate DB display names that map to the same env credential as a catalog entry. */
const AI_PROVIDER_NAME_ALIASES: Record<string, string[]> = {
  Claude: ['Anthropic'],
  NVIDIA: ['Nvidia'],
  OpenRouter: ['OpenRouter Free', 'OpenRouter (Free Tier)'],
};

/** Local / no-key engines AIRouter seeds or operators commonly add — always listed even with no DB row. */
const KNOWN_LOCAL_PROVIDERS: Array<{ providerName: string; apiEndpoint: string }> = [
  { providerName: 'Ollama (Local)', apiEndpoint: `${networkEndpoints.aiLocal.ollamaDefault}/v1` },
  { providerName: 'LiteLLM Gateway', apiEndpoint: networkEndpoints.aiLocal.liteLlmGatewayDefault },
];

export type ProviderUsageStatus = 'active' | 'inactive' | 'no_credentials' | 'not_configured';

function isLocalAiEndpoint(endpoint: string | null | undefined): boolean {
  if (!endpoint) return false;
  return endpoint.includes('localhost') || endpoint.includes('127.0.0.1') || endpoint.includes('::1');
}

function providerNamesMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function catalogNamesFor(providerName: string): string[] {
  const names = [providerName];
  for (const [canonical, aliases] of Object.entries(AI_PROVIDER_NAME_ALIASES)) {
    if (providerNamesMatch(canonical, providerName) || aliases.some((a) => providerNamesMatch(a, providerName))) {
      names.push(canonical, ...aliases);
    }
  }
  return names;
}

function resolveEnvKeyForProvider(providerName: string): string | null {
  for (const name of catalogNamesFor(providerName)) {
    const direct = AI_PROVIDER_ENV_MAP[name];
    if (direct) return direct;
    const fuzzy = Object.entries(AI_PROVIDER_ENV_MAP).find(([k]) => providerNamesMatch(k, name));
    if (fuzzy) return fuzzy[1];
  }
  return null;
}

function resolveProviderCredentials(
  providerName: string,
  apiKeyEncrypted: string | null | undefined,
): { hasCredentials: boolean; credentialSource: 'env' | 'database' | null } {
  const envKey = resolveEnvKeyForProvider(providerName);
  if (envKey && process.env[envKey]) {
    return { hasCredentials: true, credentialSource: 'env' };
  }
  // AIRouter also falls back to `${PROVIDERNAME}_API_KEY` for exact providerName uppercase.
  const looseEnv = process.env[`${providerName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`];
  if (looseEnv) {
    return { hasCredentials: true, credentialSource: 'env' };
  }
  if (apiKeyEncrypted) {
    return { hasCredentials: true, credentialSource: 'database' };
  }
  return { hasCredentials: false, credentialSource: null };
}

function classifyProviderUsage(input: {
  inDatabase: boolean;
  enabled: boolean | null | undefined;
  apiEndpoint: string | null | undefined;
  hasCredentials: boolean;
}): ProviderUsageStatus {
  if (!input.inDatabase) return 'not_configured';
  if (input.enabled === false) return 'inactive';
  if (isLocalAiEndpoint(input.apiEndpoint) || input.hasCredentials) return 'active';
  return 'no_credentials';
}

/** Rolling success vs last-call health can disagree (AIRouter sets Healthy on any success). */
function deriveDisplayHealth(row: {
  health: string | null;
  successRate: number | null;
  requests: number | null;
  lastSuccess: string | null;
  lastFailure: string | null;
  latency: number | null;
}): { displayHealth: string | null; metricsAvailable: boolean; latencyAvailable: boolean; healthNote: string | null } {
  const samples = (row.requests || 0) > 0 || !!row.lastSuccess || !!row.lastFailure;
  if (!samples) {
    return {
      displayHealth: null,
      metricsAvailable: false,
      latencyAvailable: false,
      healthNote: 'No completed AIRouter calls for this provider yet — health/latency are not probed live.',
    };
  }
  const rate = row.successRate ?? 100;
  let displayHealth = row.health || 'Unknown';
  let healthNote: string | null = null;
  // Prefer rolling success when it contradicts a last-success Healthy stamp.
  if (rate < 50) {
    displayHealth = 'Offline';
    if (row.health === 'Healthy') {
      healthNote = `Last call succeeded, but rolling success rate is ${Math.round(rate)}% — shown as Offline.`;
    }
  } else if (rate < 80) {
    displayHealth = 'Degraded';
    if (row.health === 'Healthy') {
      healthNote = `Last call succeeded, but rolling success rate is ${Math.round(rate)}% — shown as Degraded.`;
    }
  }
  // Failures do not update EMA latency — 0ms after only failures is a schema default, not a measurement.
  const latencyAvailable = (row.latency || 0) > 0 || !!row.lastSuccess;
  return { displayHealth, metricsAvailable: true, latencyAvailable, healthNote };
}

/** Exported for unit tests — merges DB rows with the known provider catalog. */
export function buildProviderInventory(dbProviders: Array<{
  id: string;
  providerName: string;
  displayName?: string | null;
  apiEndpoint?: string | null;
  apiKeyEncrypted?: string | null;
  defaultModel?: string | null;
  enabled?: boolean | null;
  priority?: number | null;
  active?: boolean | null;
  health?: string | null;
  latency?: number | null;
  successRate?: number | null;
  requests?: number | null;
  lastSuccess?: string | null;
  lastFailure?: string | null;
  [key: string]: unknown;
}>) {
  const matchedCatalog = new Set<string>();
  const matchedLocal = new Set<string>();

  const enrichedDb = dbProviders.map((p) => {
    for (const canonical of Object.keys(AI_PROVIDER_ENV_MAP)) {
      const aliases = AI_PROVIDER_NAME_ALIASES[canonical] || [];
      if (
        providerNamesMatch(p.providerName, canonical) ||
        aliases.some((a) => providerNamesMatch(p.providerName, a)) ||
        // Free-tier OpenRouter row is a distinct DB entry; still counts the OpenRouter catalog as seen.
        (canonical === 'OpenRouter' && p.providerName.toLowerCase().includes('openrouter'))
      ) {
        matchedCatalog.add(canonical);
      }
    }
    for (const local of KNOWN_LOCAL_PROVIDERS) {
      if (
        providerNamesMatch(p.providerName, local.providerName) ||
        p.providerName.toLowerCase().includes(local.providerName.split(' ')[0].toLowerCase())
      ) {
        matchedLocal.add(local.providerName);
      }
    }

    const creds = resolveProviderCredentials(p.providerName, p.apiKeyEncrypted);
    const usageStatus = classifyProviderUsage({
      inDatabase: true,
      enabled: p.enabled,
      apiEndpoint: p.apiEndpoint,
      hasCredentials: creds.hasCredentials,
    });
    const healthMeta = deriveDisplayHealth({
      health: p.health ?? null,
      successRate: p.successRate ?? null,
      requests: p.requests ?? null,
      lastSuccess: p.lastSuccess ?? null,
      lastFailure: p.lastFailure ?? null,
      latency: p.latency ?? null,
    });

    return {
      ...p,
      // Never return ciphertext to the UI — only whether a key exists.
      apiKeyEncrypted: undefined,
      hasCredentials: creds.hasCredentials,
      credentialSource: creds.credentialSource,
      usageStatus,
      isLocal: isLocalAiEndpoint(p.apiEndpoint),
      metricsAvailable: healthMeta.metricsAvailable,
      latencyAvailable: healthMeta.latencyAvailable,
      displayHealth: healthMeta.displayHealth,
      healthNote: healthMeta.healthNote,
      inDatabase: true,
    };
  });

  const missingCatalog = Object.keys(AI_PROVIDER_ENV_MAP)
    .filter((name) => !matchedCatalog.has(name))
    .map((providerName) => {
      const creds = resolveProviderCredentials(providerName, null);
      // Env key present but no DB row: still not routable until AIRouter has a row (Add Provider / restart seed).
      return {
        id: `catalog:${providerName}`,
        providerName,
        displayName: providerName,
        apiEndpoint: null,
        apiKeyEncrypted: undefined,
        defaultModel: null,
        enabled: false,
        priority: null,
        active: false,
        health: null,
        latency: null,
        successRate: null,
        requests: 0,
        hasCredentials: creds.hasCredentials,
        credentialSource: creds.credentialSource,
        usageStatus: 'not_configured' as ProviderUsageStatus,
        isLocal: false,
        metricsAvailable: false,
        latencyAvailable: false,
        displayHealth: null,
        healthNote: creds.hasCredentials
          ? 'Env key is set, but this provider has no ai_providers row yet — Add Provider (or restart after seed) so AIRouter can load it.'
          : 'Known to Argus but not in ai_providers — no credentials and not configured for routing.',
        inDatabase: false,
      };
    });

  const missingLocal = KNOWN_LOCAL_PROVIDERS
    .filter((local) => !matchedLocal.has(local.providerName))
    .map((local) => ({
      id: `catalog:${local.providerName}`,
      providerName: local.providerName,
      displayName: local.providerName,
      apiEndpoint: local.apiEndpoint,
      apiKeyEncrypted: undefined,
      defaultModel: null,
      enabled: false,
      priority: null,
      active: false,
      health: null,
      latency: null,
      successRate: null,
      requests: 0,
      hasCredentials: false,
      credentialSource: null as 'env' | 'database' | null,
      usageStatus: 'not_configured' as ProviderUsageStatus,
      isLocal: true,
      metricsAvailable: false,
      latencyAvailable: false,
      displayHealth: null,
      healthNote: 'Local endpoint is known to Argus but has no ai_providers row yet.',
      inDatabase: false,
    }));

  return [...enrichedDb, ...missingCatalog, ...missingLocal];
}
/**
 * ==========================================================
 * Module:
 * configRoutes.ts
 *
 * Purpose:
 * Core implementation and logic for the configRoutes.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for configRoutes
 * - Interface with backend APIs and EventBus
 * - Render UI components (if React)
 *
 * Inputs:
 * - Module dependencies and injected props
 *
 * Outputs:
 * - Formatted data or React Elements
 *
 * Emits:
 * - Relevant system events
 *
 * Dependencies:
 * - Standard Argus architecture layers
 *
 * Called By:
 * - Argus Routing / Parent Components
 *
 * Never:
 * - Mutate global state directly without EventBus
 * - Call AI providers directly (Must use AIRouter)
 *
 * ==========================================================
 */

import { Router } from 'express';
import { db } from '../db';
import * as schema from '../db/schema';
import { eq } from 'drizzle-orm';
import { EncryptionService } from '../core/EncryptionService';
import { tradingEngine } from '../engines/TradingEngine';
import { AIRouter } from '../ai/AIRouter';

export const configRouter = Router();

// Real bug found and fixed this pass (P0, same class as the autobot/toggle allowlist fix):
// POST /settings used to do `db.delete(schema.settings); db.insert(schema.settings).values(req.body)`
// - a full delete-and-recreate using the RAW, unvalidated client body. That let a client set
// `tradingState` directly (completely bypassing the audited kill-switch endpoints and their
// kill_switch_events trail) and `peakEquity` (letting a client reset the drawdown gate's
// high-water-mark at will, defeating Phase 1.5's max-portfolio-drawdown protection). Only these
// fields may be written through this general-purpose settings endpoint.
const SETTINGS_ALLOWED_FIELDS: (keyof typeof schema.settings.$inferInsert)[] = [
  'tradingMode', 'riskLevel', 'selectedBroker', 'selectedAiProvider', 'budget', 'strategy',
  'maxTradeSize', 'dailyLossLimit', 'takeProfitPct', 'trailingStopPct', 'minAiConfidence',
  'autoBotEnabled', 'adversarialDebateMode', 'globalAutoLiquidationEnabled', 'maxPortfolioDrawdownPct', 'maxOpenPositions',
  'maxOrdersPerMinute', 'positionSizingMode', 'percentOfEquityPct',
  'autoTradeScheduleEnabled', 'autoTradeScheduleStartTime', 'autoTradeScheduleEndTime',
  'autoTradeScheduleTimezone',
  'strategyEngineEnabled', 'strategyEngineMode', 'strategyEngineActiveIdsJson',
  'strategyEngineMaxActive', 'strategyEngineMinConfidence',
  'campaignEnabled', 'dailyTargetAmount', 'dailyTargetType', 'targetAchievedAction',
];

// Only these mode strings are real in this pass (StrategyEngineShadowRunner.ts only acts on
// SHADOW/ANALYSIS_ONLY; OFF is the default). SIGNAL_ADVISORY/CONSENSUS_PARTICIPANT/PAPER_ONLY/
// LIVE_ELIGIBLE are reserved for a future phase - accepting them here with no real behavior
// behind them would silently mislead an operator into thinking they did something.
const STRATEGY_ENGINE_REAL_MODES = ['OFF', 'SHADOW', 'ANALYSIS_ONLY'];

configRouter.get('/settings', async (req, res) => {
  try {
    const { resolveEnvTradingMode } = await import('../core/tradingModeEnv');
    const envMode = resolveEnvTradingMode();
    const allSettings = await db.select().from(schema.settings).limit(1);
    const row = allSettings[0] || { tradingMode: envMode.mode, riskLevel: 'Balanced' };
    res.json({
      ...row,
      tradingMode: tradingEngine.state.tradingMode || row.tradingMode || envMode.mode,
      PAPER_TRADING_ONLY: envMode.paperTradingOnly,
      envTradingMode: envMode.mode,
      envTradingModeSource: envMode.source,
      // Real bug fix: the Settings ribbon used to show a hardcoded "Max Sector Exp 35%" string
      // that had drifted from the actual reviewed config value (0.4 = 40%) enforced by
      // RiskEngine's real sector_concentration gate. Read-only (not in SETTINGS_ALLOWED_FIELDS -
      // this is a file-reviewed safety ceiling, not a UI-settable value), exposed here purely so
      // the frontend can display the REAL number instead of a stale literal.
      maxSectorConcentrationPct: tradingSafety.maxSectorConcentrationPct,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

configRouter.post('/settings', async (req, res) => {
  try {
    // Reject an invalid schedule window before writing anything, rather than persisting garbage
    // AutoTradeScheduler.tick() would then silently skip forever (isValidHHMM fails closed there,
    // but a client should get a real 400, not a feature that quietly never engages).
    const { isValidHHMM, isValidTimezone } = await import('../core/AutoTradeSchedule');
    for (const field of ['autoTradeScheduleStartTime', 'autoTradeScheduleEndTime'] as const) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, field) && !isValidHHMM(req.body[field])) {
        return res.status(400).json({ ok: false, error: `${field} must be "HH:MM" 24-hour format, got ${JSON.stringify(req.body[field])}` });
      }
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'autoTradeScheduleTimezone') && !isValidTimezone(req.body.autoTradeScheduleTimezone)) {
      return res.status(400).json({ ok: false, error: `autoTradeScheduleTimezone is not a recognized IANA timezone: ${JSON.stringify(req.body.autoTradeScheduleTimezone)}` });
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'strategyEngineMode') && !STRATEGY_ENGINE_REAL_MODES.includes(req.body.strategyEngineMode)) {
      return res.status(400).json({ ok: false, error: `strategyEngineMode must be one of ${STRATEGY_ENGINE_REAL_MODES.join(', ')} (other modes are reserved for a future phase): got ${JSON.stringify(req.body.strategyEngineMode)}` });
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'strategyEngineActiveIdsJson')) {
      try {
        const parsed = JSON.parse(req.body.strategyEngineActiveIdsJson);
        if (!Array.isArray(parsed) || !parsed.every((x: unknown) => typeof x === 'string')) throw new Error('not a string[]');
      } catch {
        return res.status(400).json({ ok: false, error: 'strategyEngineActiveIdsJson must be a JSON array of strings.' });
      }
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'dailyTargetType')) {
      const t = String(req.body.dailyTargetType).toUpperCase();
      if (t !== 'DOLLAR' && t !== 'PERCENT') {
        return res.status(400).json({ ok: false, error: 'dailyTargetType must be DOLLAR or PERCENT' });
      }
      req.body.dailyTargetType = t;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'targetAchievedAction')) {
      const a = String(req.body.targetAchievedAction).toUpperCase();
      if (a !== 'LOCK_AND_IDLE' && a !== 'TRAIL_STOPS_ONLY' && a !== 'CONTINUE') {
        return res.status(400).json({ ok: false, error: 'targetAchievedAction must be LOCK_AND_IDLE, TRAIL_STOPS_ONLY, or CONTINUE' });
      }
      req.body.targetAchievedAction = a;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'dailyTargetAmount')) {
      const n = Number(req.body.dailyTargetAmount);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ ok: false, error: 'dailyTargetAmount must be a finite number >= 0' });
      }
      req.body.dailyTargetAmount = n;
    }

    // Real bug fixed: SETTINGS_ALLOWED_FIELDS only ever allowlisted field *names*; a client could
    // post e.g. {"maxPortfolioDrawdownPct": 999} and silently disable the portfolio-drawdown
    // circuit breaker (that gate is just `drawdownPct < maxPortfolioDrawdownPct`). Same pattern
    // for maxOrdersPerMinute/order_rate_limit and maxOpenPositions/open_positions_cap.
    const { validateSettingsBounds } = await import('../core/settingsValidation');
    const boundsCheck = validateSettingsBounds(req.body || {});
    if (boundsCheck.ok === false) {
      return res.status(400).json({ ok: false, error: boundsCheck.error as string });
    }

    // Check the LIVE-trading confirmation gate BEFORE writing anything - toggle() already
    // applies its own (narrower) allowlist and updates tradingEngine.state/settings for the
    // fields it owns; this route additionally persists the broker/AI-provider selection fields
    // toggle() doesn't handle. Only an explicit allowlist is ever written - see
    // SETTINGS_ALLOWED_FIELDS' comment for the real bypass this closes.
    const result = await tradingEngine.toggle(req.body);
    if (!result.ok) {
      return res.status(400).json(result);
    }
    const patch: Record<string, unknown> = {};
    for (const field of SETTINGS_ALLOWED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
        patch[field] = req.body[field];
      }
    }
    if (Object.keys(patch).length > 0) {
      await db.update(schema.settings).set(patch).run();
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Persists that the Setup Wizard has been completed/skipped, so a future fresh login doesn't
// force it open again. Uses UPDATE (not the delete+insert /settings route above) so it can never
// wipe unrelated settings fields.
configRouter.post('/onboarding-complete', async (req, res) => {
  try {
    const existing = await db.select().from(schema.settings).limit(1);
    if (existing.length > 0) {
      await db.update(schema.settings).set({ onboardingComplete: true }).where(eq(schema.settings.id, existing[0].id));
    } else {
      await db.insert(schema.settings).values({ onboardingComplete: true });
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

configRouter.get('/brokers', async (req, res) => {
  try {
    const brokers = await db.select().from(schema.brokerConnections);
    // Real bug fixed: this returned raw rows including apiKeyEncrypted/secretEncrypted ciphertext
    // - unlike every other credential-status surface in this file (see buildProviderInventory's
    // "Never return ciphertext to the UI" and /wizard-status's own "never reads or returns
    // key/secret values" comment). This route is also reachable via the duplicate bare
    // app.use("/api/v1", configRouter) mount in server.ts, so masking here (rather than relying on
    // the caller to know which mount served the request) protects both paths.
    const masked = brokers.map((b) => ({
      ...b,
      apiKeyEncrypted: undefined,
      secretEncrypted: undefined,
      hasApiKey: !!b.apiKeyEncrypted,
      hasSecret: !!b.secretEncrypted,
    }));
    res.json(masked);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

configRouter.post('/brokers', async (req, res) => {
  try {
    // paperMode is deliberately excluded from `rest` below - this form (Add/Update Credentials)
    // must never be able to set a connection live. BrokerManager.setLiveMode() (the
    // /brokers/:id/live-mode route) is the only path that may do that, and it requires both a
    // real capability check and LIVE_TRADING_CONFIRMATION_PHRASE. Without this, a raw POST here
    // (or a buggy client) could have silently created a connection already in live mode, with
    // real money at risk, the moment BrokerManager.initialize() next read it - never having gone
    // through that confirmation gate at all.
    const { brokerName, apiKeyEncrypted, apiSecretEncrypted, paperMode, ...rest } = req.body;
    let finalKey = apiKeyEncrypted;
    let finalSecret = apiSecretEncrypted;
    if (apiKeyEncrypted && !apiKeyEncrypted.includes(':')) {
       finalKey = EncryptionService.encrypt(apiKeyEncrypted);
    }
    if (apiSecretEncrypted && !apiSecretEncrypted.includes(':')) {
       finalSecret = EncryptionService.encrypt(apiSecretEncrypted);
    }

    // Update-if-exists, not a blind insert: `brokerName` has no unique DB constraint, so
    // re-submitting this form for the same broker used to silently create a second row.
    // BrokerManager.initialize() reads brokerConnections via .find(b => b.brokerName === ...),
    // which returns whichever row query order puts first (typically the oldest) - meaning a
    // credential *update* could silently never take effect. paperMode is intentionally omitted
    // from the update too, so rotating credentials on an already-live connection can never
    // silently flip it back to paper.
    const existing = await db.select().from(schema.brokerConnections).where(eq(schema.brokerConnections.brokerName, brokerName));
    if (existing.length > 0) {
      const updateValues: Record<string, any> = { ...rest };
      if (finalKey) updateValues.apiKeyEncrypted = finalKey;
      if (finalSecret) updateValues.secretEncrypted = finalSecret;
      await db.update(schema.brokerConnections).set(updateValues).where(eq(schema.brokerConnections.id, existing[0].id));
    } else {
      await db.insert(schema.brokerConnections).values({
         brokerName,
         apiKeyEncrypted: finalKey,
         secretEncrypted: finalSecret,
         ...rest,
         paperMode: true,
      });
    }
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

configRouter.get('/providers', async (req, res) => {
  try {
    // Merge ai_providers rows with the known env catalog + local engines so Settings can show
    // not-configured / no-key providers — previously the UI only listed DB rows and labeled them all "Active".
    const providers = await db.select().from(schema.aiProviders);
    res.json(buildProviderInventory(providers));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

configRouter.post('/providers', async (req, res) => {
  try {
    const { provider, apiKey, apiEndpoint, defaultModel } = req.body;
    const existing = await db.select().from(schema.aiProviders).where(eq(schema.aiProviders.providerName, provider));

    if (existing && existing.length > 0) {
       await db.update(schema.aiProviders).set({
          apiKeyEncrypted: apiKey ? EncryptionService.encrypt(apiKey) : null,
          apiEndpoint: apiEndpoint ?? existing[0].apiEndpoint,
          defaultModel: defaultModel ?? existing[0].defaultModel,
          enabled: true
       }).where(eq(schema.aiProviders.providerName, provider));
    } else {
       await db.insert(schema.aiProviders).values({
         id: uuidv4(),
         providerName: provider,
         displayName: provider,
         apiKeyEncrypted: apiKey ? EncryptionService.encrypt(apiKey) : null,
         apiEndpoint: apiEndpoint || null,
         defaultModel: defaultModel || null,
         enabled: true
       });
    }
    // NOTE: AIRouter.initialize() only runs once at server boot - it has no
    // single-provider hot-reload path. A saved/updated provider (including its
    // apiEndpoint/defaultModel) only takes effect after a server restart.
    res.json({ ok: true, note: "Restart the server for this provider change to take effect." });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

configRouter.get('/models', async (req, res) => {
  try {
    const models = await db.select().from(schema.aiModels);
    res.json(models);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

configRouter.get('/provider-status', async (req, res) => {
  try {
    const dbProviders = await db.select().from(schema.aiProviders);

    const statuses: ProviderStatus[] = Object.entries(AI_PROVIDER_ENV_MAP).map(([provider, envKey]) => {
      if (process.env[envKey]) {
        return { provider, isConfigured: true, source: 'env' as const };
      }
      const dbMatch = dbProviders.find(
        p => p.providerName.toLowerCase() === provider.toLowerCase() && p.apiKeyEncrypted
      );
      if (dbMatch) {
        return { provider, isConfigured: true, source: 'database' as const };
      }
      return { provider, isConfigured: false, source: null };
    });

    res.json(statuses);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

configRouter.get('/usage', async (req, res) => {
  try {
    const usage = await db.select().from(schema.aiUsage);
    res.json(usage);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Per-agent AI provider routing overrides. AIProviderManagement.tsx's "Agent Routing" tab has
// always posted here; AIRouter.setAgentRoute()/agentRouting map already existed and routeTask()
// already reads it, but nothing ever persisted an override or called setAgentRoute() at runtime.
// This is the missing wiring, not new routing logic.
configRouter.get('/routing', async (req, res) => {
  try {
    const overrides = await db.select().from(schema.agentRoutingOverrides);
    res.json(overrides);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

configRouter.post('/routing', async (req, res) => {
  try {
    const { agent, providerId, model } = req.body;
    if (!agent || !providerId) {
      return res.status(400).json({ error: 'agent and providerId are required' });
    }

    const router = AIRouter.getInstance();

    if (providerId === 'auto') {
      await db.delete(schema.agentRoutingOverrides).where(eq(schema.agentRoutingOverrides.agentName, agent));
      router.clearAgentRoute(agent);
      return res.json({ ok: true, cleared: true });
    }

    const existing = await db.select().from(schema.agentRoutingOverrides).where(eq(schema.agentRoutingOverrides.agentName, agent));
    const now = new Date().toISOString();
    if (existing.length > 0) {
      await db.update(schema.agentRoutingOverrides)
        .set({ providerId, model: model ?? null, updatedAt: now })
        .where(eq(schema.agentRoutingOverrides.agentName, agent));
    } else {
      await db.insert(schema.agentRoutingOverrides).values({ agentName: agent, providerId, model: model ?? null, updatedAt: now });
    }

    router.setAgentRoute(agent, providerId, model || '');
    res.json({ ok: true });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * Aggregate configuration-detection status for the Setup Wizard: which AI
 * providers, brokers, and data providers already have a usable credential,
 * and whether it came from process.env or the database.
 *
 * SECURITY: this route never reads or returns key/secret *values* - only
 * whether a non-null encrypted value exists in the DB, or whether the env
 * var is set. No plaintext or ciphertext ever leaves this handler.
 */
configRouter.get('/wizard-status', async (req, res) => {
  try {
    const [dbProviders, dbBrokers] = await Promise.all([
      db.select({ providerName: schema.aiProviders.providerName, hasKey: schema.aiProviders.apiKeyEncrypted }).from(schema.aiProviders),
      db.select({ brokerName: schema.brokerConnections.brokerName, hasKey: schema.brokerConnections.apiKeyEncrypted }).from(schema.brokerConnections),
    ]);

    const aiProviders: Record<string, ConfigItemStatus> = {};
    for (const [provider, envKey] of Object.entries(AI_PROVIDER_ENV_MAP)) {
      if (process.env[envKey]) {
        aiProviders[provider] = { isConfigured: true, source: 'env' };
        continue;
      }
      const dbMatch = dbProviders.find(
        (p) => p.providerName.toLowerCase() === provider.toLowerCase() && !!p.hasKey
      );
      aiProviders[provider] = dbMatch ? { isConfigured: true, source: 'db' } : { isConfigured: false, source: null };
    }

    const brokers: Record<string, ConfigItemStatus> = {};
    if (process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY) {
      brokers.Alpaca = { isConfigured: true, source: 'env' };
    } else {
      const dbMatch = dbBrokers.find((b) => b.brokerName.toLowerCase() === 'alpaca' && !!b.hasKey);
      brokers.Alpaca = dbMatch ? { isConfigured: true, source: 'db' } : { isConfigured: false, source: null };
    }

    const dataProviders: Record<string, ConfigItemStatus> = {};
    for (const [provider, envKey] of Object.entries(DATA_PROVIDER_ENV_MAP)) {
      dataProviders[provider] = process.env[envKey]
        ? { isConfigured: true, source: 'env' }
        : { isConfigured: false, source: null };
    }

    const payload: WizardStatusResponse = { aiProviders, brokers, dataProviders };
    res.json(payload);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
