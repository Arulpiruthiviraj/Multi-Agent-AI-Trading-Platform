import { v4 as uuidv4 } from 'uuid';

interface ProviderStatus {
  provider: string;
  isConfigured: boolean;
  source: 'env' | 'database' | null;
}

const AI_PROVIDER_ENV_MAP: Record<string, string> = {
  Gemini:     'GEMINI_API_KEY',
  OpenAI:     'OPENAI_API_KEY',
  Claude:     'ANTHROPIC_API_KEY',
  DeepSeek:   'DEEPSEEK_API_KEY',
  Groq:       'GROQ_API_KEY',
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

export const configRouter = Router();

configRouter.get('/settings', async (req, res) => {
  try {
    const allSettings = await db.select().from(schema.settings).limit(1);
    res.json(allSettings[0] || { tradingMode: 'Paper', riskLevel: 'Balanced' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

configRouter.post('/settings', async (req, res) => {
  try {
    await db.delete(schema.settings);
    await db.insert(schema.settings).values(req.body);
    tradingEngine.toggle(req.body); 
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
    const { brokerName, apiKeyEncrypted, apiSecretEncrypted, ...rest } = req.body;
    let finalKey = apiKeyEncrypted;
    let finalSecret = apiSecretEncrypted;
    if (apiKeyEncrypted && !apiKeyEncrypted.includes(':')) {
       finalKey = EncryptionService.encrypt(apiKeyEncrypted);
    }
    if (apiSecretEncrypted && !apiSecretEncrypted.includes(':')) {
       finalSecret = EncryptionService.encrypt(apiSecretEncrypted);
    }
    await db.insert(schema.brokerConnections).values({
       brokerName,
       apiKeyEncrypted: finalKey,
       apiSecretEncrypted: finalSecret,
       ...rest
    });
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
