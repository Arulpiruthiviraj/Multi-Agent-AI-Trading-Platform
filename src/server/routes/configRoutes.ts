import { v4 as uuidv4 } from 'uuid';
import { ConfigItemStatus, WizardStatusResponse } from '../types/wizardStatus';

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
  'autoBotEnabled', 'adversarialDebateMode', 'maxPortfolioDrawdownPct', 'maxOpenPositions',
  'maxOrdersPerMinute', 'positionSizingMode', 'percentOfEquityPct',
  'autoTradeScheduleEnabled', 'autoTradeScheduleStartTime', 'autoTradeScheduleEndTime',
];

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
    const { isValidHHMM } = await import('../core/AutoTradeSchedule');
    for (const field of ['autoTradeScheduleStartTime', 'autoTradeScheduleEndTime'] as const) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, field) && !isValidHHMM(req.body[field])) {
        return res.status(400).json({ ok: false, error: `${field} must be "HH:MM" 24-hour format, got ${JSON.stringify(req.body[field])}` });
      }
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
    res.json(brokers);
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
    const providers = await db.select().from(schema.aiProviders);
    res.json(providers);
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
