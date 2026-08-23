import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { allowAiCall, getPipelineRateSnapshot } from '../core/pipelineRateLimit';
/**
 * ==========================================================
 * Module:
 * AIRouter.ts
 *
 * Purpose:
 * Provider-agnostic AI platform abstraction for all trading agents.
 * 
 * Responsibilities:
 * - Maintain a registry of available AI providers.
 * - Route agent prompts to the best available model.
 * - Handle failovers, retries, and rate limits.
 * - Track token usage, costs, latency, and provider health.
 * - Log all AI usage metrics to SQLite.
 * - Broadcast AI telemetry to the frontend via WebSockets.
 *
 * Inputs:
 * - Agent Type (e.g. 'Technical', 'Risk', 'Chief Trader')
 * - System Prompts / Context
 *
 * Outputs:
 * - Standardized JSON or text completions.
 *
 * Emits:
 * - ai_metrics_update (WebSocket)
 *
 * Dependencies:
 * - sqlite (aiProviders, aiUsage tables)
 * - BaseAIProvider adapters
 *
 * Called By:
 * - All AI Agents in the AutonomousTradingEngine.
 *
 * Never:
 * - Hardcode API keys (loaded securely from DB/ENV).
 * - Allow trading logic to bypass the router.
 *
 * ==========================================================
 */

import { AIProvider } from './providers/AIProvider';
import { GeminiProvider } from './providers/GeminiProvider';
import { DeepSeekProvider } from './providers/DeepSeekProvider';
import { OpenAIProvider } from './providers/OpenAIProvider';
import { OpenAICompatibleProvider } from './providers/OpenAICompatibleProvider';
import { NvidiaProvider } from './providers/NvidiaProvider';
import { db } from '../db';
import * as schema from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { EncryptionService } from '../core/EncryptionService';
import { coerceEnum, clampScore, coerceString, coerceStringArray, TRADE_SIDE_VALUES } from './AIOutputValidator';
import { tradingSafety } from '../config/tradingSafety';
import { networkEndpoints } from '../config/networkEndpoints';
import { aiModels, isResearchAgentType } from '../config/aiModels';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';
import { hashSensitive } from '../observability/hashSensitive';

// Router timeout (tradingSafety.aiProviderTimeoutMs) plus AbortController so fetch-based
// providers cancel in-flight HTTP instead of hanging after the caller has already failed over.
const AI_PROVIDER_TIMEOUT_MS = tradingSafety.aiProviderTimeoutMs;
/** Bull/Bear + ConsensusDebate — config/aiModels.json researchTimeoutMs (fail-closed HOLD). */
const RESEARCH_TIMEOUT_MS = aiModels.researchTimeoutMs;
const AI_AUTH_FAILURE_COOLDOWN_MS = tradingSafety.aiProviderAuthFailureCooldownMs;
const AI_UNREACHABLE_COOLDOWN_MS = tradingSafety.aiProviderUnreachableCooldownMs;
const AI_TIMEOUT_SKIP_COOLDOWN_MS = tradingSafety.aiProviderTimeoutSkipCooldownMs;
// Phase 7 (AI_MODEL_INVENTORY.md) - a low, non-zero temperature for every real trading-decision
// call. Previously unset anywhere (each provider's own undocumented default sampling applied) -
// this makes AI-influenced consensus votes measurably more reproducible without forcing fully
// deterministic (temperature=0) sampling, which some providers handle poorly for longer
// structured-JSON responses. Centralized here rather than duplicated per-provider so the policy
// lives in one place.
const AI_DECISION_TEMPERATURE = tradingSafety.aiDecisionTemperature;

/**
 * True for empty / whitespace / common .env wizard placeholders that must never be treated as
 * real cloud credentials. Local Ollama does not need a key — callers pass isLocal separately.
 */
export function isPlaceholderApiKey(apiKey?: string | null): boolean {
  if (apiKey == null) return true;
  const trimmed = String(apiKey).trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (lower.length < 8) return true;
  if (
    /^(change[_-]?me|your[_-].*|xxx+|x{8,}|placeholder|example|todo|fixme|insert|replace|dummy|test[_-]?key|sk-x+|none|null|undefined|n\/a|na)$/i.test(lower)
  ) {
    return true;
  }
  if (
    lower.includes('changeme')
    || lower.includes('change_me')
    || lower.includes('your_')
    || lower.includes('your-')
    || lower.includes('placeholder')
    || lower.includes('example')
    || lower.includes('insert_')
    || lower.includes('replace_')
  ) {
    return true;
  }
  return false;
}

export function shouldSkipUnconfiguredProvider(opts: { apiKey?: string | null; isLocal: boolean }): boolean {
  // Local OpenAI-compatible (Ollama) is usable without a cloud key.
  if (opts.isLocal) return false;
  return isPlaceholderApiKey(opts.apiKey);
}

export function selectConsensusProviders<T>(providers: [string, T][], maxProviders: number): [string, T][] {
  if (maxProviders <= 0) return [];
  return providers.slice(0, maxProviders);
}

function envKeyForProviderName(providerName: string): string | undefined {
  const compact = providerName.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  const candidates = [
    `${compact}_API_KEY`,
    `${providerName.toUpperCase()}_API_KEY`,
  ];
  if (providerName.toLowerCase().includes('openrouter')) candidates.unshift('OPENROUTER_API_KEY');
  if (providerName.toLowerCase().includes('gemini')) candidates.unshift('GEMINI_API_KEY');
  if (providerName.toLowerCase().includes('openai')) candidates.unshift('OPENAI_API_KEY');
  if (providerName.toLowerCase().includes('nvidia')) candidates.unshift('NVIDIA_API_KEY');
  if (providerName.toLowerCase().includes('deepseek')) candidates.unshift('DEEPSEEK_API_KEY');
  if (providerName.toLowerCase().includes('grok') || providerName.toLowerCase().includes('x.ai')) candidates.unshift('XAI_API_KEY', 'GROK_API_KEY');
  for (const name of candidates) {
    const v = process.env[name];
    if (v == null) continue;
    const trimmed = String(v).trim();
    if (!trimmed || isPlaceholderApiKey(trimmed)) continue;
    return trimmed;
  }
  return undefined;
}

/** Honest consensus short-circuit copy — distinguish zero registered vs keys present but unroutable. */
export function describeConsensusProvidersUnavailable(opts: {
  registeredCount: number;
  skippedAuthCooldown: number;
  skippedTemporary: number;
  skippedDisabledInDb: number;
}): string {
  if (opts.registeredCount <= 0) {
    return 'No AI providers registered for consensus (no usable API keys and no local Ollama). Fail-closed HOLD.';
  }
  const parts: string[] = [];
  if (opts.skippedAuthCooldown > 0) parts.push(`${opts.skippedAuthCooldown} in auth cooldown`);
  if (opts.skippedTemporary > 0) parts.push(`${opts.skippedTemporary} temporarily skipped (timeout/unreachable)`);
  if (opts.skippedDisabledInDb > 0) parts.push(`${opts.skippedDisabledInDb} DB-disabled`);
  const detail = parts.length > 0 ? parts.join(', ') : 'filtered out';
  return `No routable AI providers for consensus (${opts.registeredCount} registered but unroutable: ${detail}). API keys may exist but be misconfigured, Offline, or placeholder — not the same as zero providers. Fail-closed HOLD.`;
}

class AITimeoutError extends Error {
  constructor(providerId: string, ms: number) {
    super(`AI provider '${providerId}' did not respond within ${ms}ms`);
    this.name = 'AITimeoutError';
  }
}

function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number, providerId: string): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new AITimeoutError(providerId, ms));
    }, ms);
    fn(controller.signal).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); controller.abort(); reject(err); },
    );
  });
}

// Whether a provider DB row is a local endpoint - matches the exact same check initialize() uses
// to decide isLocal when constructing an OpenAICompatibleProvider. More reliable than inferring
// "local" from a $0 estimateCost() result, which is also literally 0 for a paid aggregator that
// failed before any tokens were counted (0 tokens -> 0 cost regardless of pricing formula).
function isLocalProviderRow(row: { apiEndpoint: string | null } | undefined): boolean {
  return !!row?.apiEndpoint && (row.apiEndpoint.includes('localhost') || row.apiEndpoint.includes('127.0.0.1'));
}

// Real bug fix, found live: Gemini's actual real-key-rejection message is "API key not valid.
// Please pass a valid API key." (status field API_KEY_INVALID) - it never contained the literal
// substring "invalid api key" the original regex looked for ("API key not valid" is phrased the
// other way around), so a permanently-dead Gemini key was never circuit-broken and kept being
// retried every single cycle, unlike every other provider's 401/403. Broadened to also catch
// Gemini's real phrasing and its machine-readable status string.
export function isAuthFailureError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(401|403)\b/.test(msg)
    || /unauthorized|forbidden|invalid api key|api key not valid|api_key_invalid|authentication/i.test(msg);
}

/** 404 / network-down — skip for aiProviderUnreachableCooldownMs; do not flip DB enabled. */
export function isUnreachableProviderError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b404\b/.test(msg)
    || /fetch failed/i.test(msg)
    || /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET/i.test(msg);
}

/** Hung / aborted chat — skip for aiProviderTimeoutSkipCooldownMs so NewsAgent does not re-pay 12s every cycle. */
export function isTimeoutSkipError(err: unknown): boolean {
  if (err instanceof AITimeoutError) return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /did not respond within/i.test(msg);
}

function extractHttpStatus(err: unknown): number | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/\b(401|403|404)\b/);
  return m ? Number(m[1]) : undefined;
}

// Phase 1 (TRANSACTION_OBSERVATORY_ARCHITECTURE.md) - the AI call forensic ledger. Previously
// the real prompt sent and the real raw response received were discarded in-memory the moment
// a call returned; only aggregate token/latency/cost counters survived into `ai_usage`. This is
// deliberately fire-and-forget (never awaited by callers, never throws past this function) -
// persisting the ledger must never be able to break a real trading decision.
interface AiCallLogInput {
  traceId?: string;
  agent: string;
  provider: string;
  model?: string;
  prompt?: string;
  rawResponse?: string;
  parsedResponse?: string;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  latencyMs?: number;
  status: 'success' | 'error';
  error?: string;
}

async function logAiCall(input: AiCallLogInput): Promise<string> {
  const id = uuidv4();
  try {
    await db.insert(schema.aiCalls).values({
      id,
      traceId: input.traceId,
      agent: input.agent,
      provider: input.provider,
      model: input.model,
      prompt: input.prompt,
      rawResponse: input.rawResponse,
      parsedResponse: input.parsedResponse,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      cost: input.cost,
      latencyMs: input.latencyMs,
      status: input.status,
      error: input.error,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[AIRouter] Failed to persist ai_calls row', e);
  }
  observeSafe(() => {
    structuredLogger.info('ai_call', {
      category: 'AI',
      component: 'AIRouter',
      eventType: 'AI_CALL',
      traceId: input.traceId,
      decisionId: input.traceId,
      agent: input.agent,
      provider: input.provider,
      model: input.model,
      status: input.status,
      latencyMs: input.latencyMs,
      promptHash: hashSensitive(input.prompt),
      responseHash: hashSensitive(input.rawResponse),
    });
  });
  return id;
}

export class AIRouter {
  private static instance: AIRouter;
  private providers: Map<string, AIProvider> = new Map();
  // Map agent name to provider and model
  private agentRouting: Map<string, { providerId: string, model: string }> = new Map();
  /** Auth-failed providers stay out of the routing pool until this wall-clock ms. */
  private authDisabledUntil: Map<string, number> = new Map();
  /** 404 / timeout / fetch-failed skip (in-memory only — not a DB enabled:false). */
  private skipUntil: Map<string, number> = new Map();
  private lastExhaustionEmitAt = 0;

  private constructor() {}

  public static getInstance(): AIRouter {
    if (!AIRouter.instance) {
      AIRouter.instance = new AIRouter();
    }
    return AIRouter.instance;
  }

  public registerProvider(id: string, provider: AIProvider) {
    this.providers.set(id, provider);
  }

  /** Test-only helper (also real, additive API surface - not gated behind NODE_ENV) - clears
   *  registered providers without initialize()'s DB reads/seeding side effects. */
  public clearProviders() {
    this.providers.clear();
    this.authDisabledUntil.clear();
    this.skipUntil.clear();
    this.lastExhaustionEmitAt = 0;
  }

  /** Test-only — inspect auth circuit state without reaching into private fields elsewhere. */
  public isProviderAuthDisabled(providerId: string, nowMs: number = Date.now()): boolean {
    const until = this.authDisabledUntil.get(providerId);
    return typeof until === 'number' && until > nowMs;
  }

  /** Test-only — inspect 404/timeout skip without reaching into private fields. */
  public isProviderTemporarilySkipped(providerId: string, nowMs: number = Date.now()): boolean {
    const until = this.skipUntil.get(providerId);
    return typeof until === 'number' && until > nowMs;
  }

  private async disableProviderForAuthFailure(providerId: string, reason: string): Promise<void> {
    const until = Date.now() + AI_AUTH_FAILURE_COOLDOWN_MS;
    this.authDisabledUntil.set(providerId, until);
    // Keep the provider registered: filterRoutableProviders excludes it until cooldown expires.
    // Permanently setting enabled=false + deleting from the map made real GEMINI/OPENAI env keys
    // look like "No AI Providers available for consensus" until manual DB surgery / full re-init.
    try {
      await db.update(schema.aiProviders).set({
        health: 'Offline',
        lastFailure: new Date().toISOString(),
      }).where(eq(schema.aiProviders.id, providerId));
    } catch (e) {
      console.error(`[AIRouter] Failed to mark provider ${providerId} Offline after auth failure`, e);
    }
    console.warn(`[AIRouter] Provider ${providerId} auth-failed (${reason}) — skipped for ${AI_AUTH_FAILURE_COOLDOWN_MS / 1000}s (not permanently DB-disabled).`);
  }

  private skipProviderTemporarily(providerId: string, cooldownMs: number, reason: string): void {
    const now = Date.now();
    const existing = this.skipUntil.get(providerId);
    if (typeof existing === 'number' && existing > now) {
      const extended = now + cooldownMs;
      if (extended > existing) this.skipUntil.set(providerId, extended);
      return;
    }
    this.skipUntil.set(providerId, now + cooldownMs);
    console.warn(`[AIRouter] Provider ${providerId} skipped for ${cooldownMs / 1000}s (${reason})`);
  }

  private noteProviderSkipFromError(providerId: string, err: unknown): void {
    if (isTimeoutSkipError(err)) {
      this.skipProviderTemporarily(providerId, AI_TIMEOUT_SKIP_COOLDOWN_MS, err instanceof Error ? err.message : String(err));
      return;
    }
    if (isUnreachableProviderError(err)) {
      this.skipProviderTemporarily(providerId, AI_UNREACHABLE_COOLDOWN_MS, err instanceof Error ? err.message : String(err));
    }
  }

  private filterRoutableProviders(entries: [string, AIProvider][], dbStats: typeof schema.aiProviders.$inferSelect[]): [string, AIProvider][] {
    const now = Date.now();
    return entries.filter(([id]) => {
      const until = this.authDisabledUntil.get(id);
      if (typeof until === 'number' && until > now) return false;
      const skipUntil = this.skipUntil.get(id);
      if (typeof skipUntil === 'number' && skipUntil > now) return false;
      const stat = dbStats.find(s => s.id === id);
      return !stat || stat.enabled !== false;
    });
  }

  /** Diagnostic counts for honest "no routable providers" errors (consensus / routeTask). */
  private countUnroutableReasons(
    entries: [string, AIProvider][],
    dbStats: typeof schema.aiProviders.$inferSelect[],
  ): { skippedAuthCooldown: number; skippedTemporary: number; skippedDisabledInDb: number } {
    const now = Date.now();
    let skippedAuthCooldown = 0;
    let skippedTemporary = 0;
    let skippedDisabledInDb = 0;
    for (const [id] of entries) {
      const until = this.authDisabledUntil.get(id);
      if (typeof until === 'number' && until > now) {
        skippedAuthCooldown += 1;
        continue;
      }
      const skipUntil = this.skipUntil.get(id);
      if (typeof skipUntil === 'number' && skipUntil > now) {
        skippedTemporary += 1;
        continue;
      }
      const stat = dbStats.find(s => s.id === id);
      if (stat && stat.enabled === false) skippedDisabledInDb += 1;
    }
    return { skippedAuthCooldown, skippedTemporary, skippedDisabledInDb };
  }

  private emitProvidersExhausted(payload: Record<string, unknown>): void {
    const now = Date.now();
    if (now - this.lastExhaustionEmitAt < AI_UNREACHABLE_COOLDOWN_MS) return;
    this.lastExhaustionEmitAt = now;
    eventBus.publish('AI_PROVIDERS_EXHAUSTED', payload);
  }

  private async probeProviderAtStartup(providerId: string, provider: AIProvider): Promise<void> {
    try {
      if (!(await provider.authenticate())) {
        await this.disableProviderForAuthFailure(providerId, 'startup authenticate() returned false');
        return;
      }
      const res = await withTimeout(
        (signal) => provider.chat('Reply with exactly: OK', { temperature: 0, signal }),
        Math.min(AI_PROVIDER_TIMEOUT_MS, 8000),
        providerId,
      );
      if (!res.content) {
        await this.disableProviderForAuthFailure(providerId, 'startup health probe returned empty content');
      }
    } catch (e: any) {
      const status = extractHttpStatus(e);
      if (status === 401 || status === 403 || isAuthFailureError(e)) {
        await this.disableProviderForAuthFailure(providerId, e.message);
      } else {
        this.noteProviderSkipFromError(providerId, e);
        console.warn(`[AIRouter] Startup health probe for ${providerId} failed (non-auth): ${e.message}`);
      }
    }
  }

  public async initialize() {
     this.providers.clear();
     this.authDisabledUntil.clear();
     this.skipUntil.clear();
     
     // Load DB providers
     let dbProviders;
     try {
       dbProviders = await db.select().from(schema.aiProviders);
     } catch (e) {
       console.error("Failed to load providers from DB", e);
       dbProviders = [];
     }
     
     if (dbProviders.length === 0) {
        // Seed some defaults
        const defaultProviders = [
            { id: uuidv4(), providerName: 'Gemini', apiEndpoint: null, priority: 0, enabled: true },
            { id: uuidv4(), providerName: 'Grok', apiEndpoint: networkEndpoints.aiCloud.grokBaseUrl, priority: 1, enabled: true, defaultModel: 'grok-4' },
            { id: uuidv4(), providerName: 'OpenRouter (Free Tier)', apiEndpoint: networkEndpoints.aiCloud.openRouterBaseUrl, priority: 2, enabled: true },
            { id: uuidv4(), providerName: 'LiteLLM Gateway', apiEndpoint: networkEndpoints.aiLocal.liteLlmGatewayDefault, priority: 3, enabled: true },
            { id: uuidv4(), providerName: 'Ollama (Local)', apiEndpoint: `${networkEndpoints.aiLocal.ollamaDefault}/v1`, priority: 4, enabled: true },
        ];
        try {
            for (const p of defaultProviders) {
               await db.insert(schema.aiProviders).values(p);
            }
            dbProviders = await db.select().from(schema.aiProviders);
        } catch (e) {}
     }

     // Heal providers previously stuck enabled=false after a single auth failure (legacy behavior).
     // If a usable env key (or local endpoint) is present, re-enable so debate can try again.
     for (const p of dbProviders) {
       if (p.enabled !== false) continue;
       const endpointHint = p.apiEndpoint || '';
       const isLocalEndpoint = endpointHint.includes('localhost') || endpointHint.includes('127.0.0.1');
       let apiKey: string | undefined;
       try {
         apiKey = p.apiKeyEncrypted ? EncryptionService.decrypt(p.apiKeyEncrypted) : envKeyForProviderName(p.providerName);
       } catch {
         continue;
       }
       if (isLocalEndpoint || !isPlaceholderApiKey(apiKey)) {
         try {
           await db.update(schema.aiProviders).set({ enabled: true, health: 'Degraded' }).where(eq(schema.aiProviders.id, p.id));
           p.enabled = true;
           console.warn(`[AIRouter] Re-enabled previously DB-disabled provider ${p.providerName} (usable local endpoint or env key present).`);
         } catch (e) {
           console.error(`[AIRouter] Failed to re-enable provider ${p.providerName}`, e);
         }
       }
     }
     
     for (const p of dbProviders) {
         if (!p.enabled) continue;
         
         let apiKey: string | undefined;
         try {
           apiKey = p.apiKeyEncrypted ? EncryptionService.decrypt(p.apiKeyEncrypted) : envKeyForProviderName(p.providerName);
         } catch {
           console.error(`[AIRouter] DECRYPTION_FAILED for provider ${p.providerName} — skipping that provider.`);
           continue;
         }
         // Encrypted DB keys can still be placeholders from Setup Wizard — normalize.
         if (apiKey && isPlaceholderApiKey(apiKey)) {
           apiKey = undefined;
         }
         let providerInstance: AIProvider | null = null;
         
         const nameLower = p.providerName.toLowerCase();
         const endpointHint = p.apiEndpoint || '';
         const isLocalEndpoint = endpointHint.includes('localhost') || endpointHint.includes('127.0.0.1');
         if (shouldSkipUnconfiguredProvider({ apiKey, isLocal: isLocalEndpoint })) {
           console.warn(`[AIRouter] Skipping ${p.providerName} — missing or placeholder API key (DEF-14).`);
           continue;
         }
         if (nameLower.includes('gemini') && !p.apiEndpoint) {
             providerInstance = new GeminiProvider();
             await (providerInstance as GeminiProvider).initialize(apiKey);
         } else if (nameLower.includes('deepseek') && !p.apiEndpoint) {
             providerInstance = new DeepSeekProvider();
             await (providerInstance as DeepSeekProvider).initialize(apiKey);
         
         } else if (nameLower.includes('openai') && !p.apiEndpoint && !nameLower.includes('compatible')) {
             providerInstance = new OpenAIProvider();
             await (providerInstance as OpenAIProvider).initialize(apiKey);
         } else if (nameLower.includes('nvidia')) {
             providerInstance = new NvidiaProvider();
             await (providerInstance as NvidiaProvider).initialize(apiKey, p.defaultModel || undefined);
         } else {

             // Universal compatible (LiteLLM, OpenRouter, Local, Groq, etc)
             const endpoint = p.apiEndpoint || networkEndpoints.aiCloud.openRouterBaseUrl;
             const isLocal = endpoint.includes('localhost') || endpoint.includes('127.0.0.1');
             providerInstance = new OpenAICompatibleProvider(p.providerName, endpoint, isLocal);
             await (providerInstance as OpenAICompatibleProvider).initialize(apiKey, p.defaultModel || undefined);
         }
         
         if (providerInstance) {
             this.registerProvider(p.id, providerInstance);
         }
     }

     for (const [id, provider] of Array.from(this.providers.entries())) {
       await this.probeProviderAtStartup(id, provider);
     }

     // Apply config/aiModels.json's per-agent local-model specialization as the DEFAULT routing -
     // real agentType keys only (grepped from actual routeTask() call sites, see that file's own
     // header). Runs BEFORE persisted agent_routing_overrides below so a user's own Settings
     // choice always wins over this file, exactly like every other config-vs-DB-override
     // precedence in this codebase.
     try {
         const ollamaRow = dbProviders.find(p =>
           p.providerName === 'Ollama (Local)'
           || (typeof p.apiEndpoint === 'string' && (p.apiEndpoint.includes('11434') || /ollama/i.test(p.providerName)))
         );
         const ollamaEnabledInConfig = aiModels.ollama?.enabled !== false;
         if (ollamaEnabledInConfig && ollamaRow && this.providers.has(ollamaRow.id)) {
             for (const [agentType, route] of Object.entries(aiModels.routes)) {
                 this.setAgentRoute(agentType, ollamaRow.id, route.model);
             }
             console.log(`[AIRouter] Applied config/aiModels.json local Ollama routes via ${ollamaRow.providerName}.`);
         } else if (ollamaEnabledInConfig && ollamaRow && !this.providers.has(ollamaRow.id)) {
             console.warn('[AIRouter] Ollama (Local) is configured in aiModels.json / DB but was not registered (health probe skip or disabled). Consensus may lack a local fallback.');
         }
     } catch (e) {
         console.error('[AIRouter] Failed to apply config/aiModels.json default routes', e);
     }

     // Load persisted per-agent routing overrides (Phase 6) - setAgentRoute() already existed
     // and routeTask() already checked this.agentRouting, but nothing ever populated it.
     try {
         const overrides = await db.select().from(schema.agentRoutingOverrides);
         for (const o of overrides) {
             this.setAgentRoute(o.agentName, o.providerId, o.model || '');
         }
         if (overrides.length > 0) {
             console.log(`[AIRouter] Loaded ${overrides.length} agent routing override(s) from DB.`);
         }
     } catch (e) {
         console.error('[AIRouter] Failed to load agent routing overrides', e);
     }
  }

  public setAgentRoute(agentType: string, providerId: string, model: string) {
     this.agentRouting.set(agentType, { providerId, model });
  }

  public clearAgentRoute(agentType: string) {
     this.agentRouting.delete(agentType);
  }

  
  public async routeConsensus(agentType: string, prompt: string, traceId: string): Promise<any> {
    let availableProviders = Array.from(this.providers.entries());
    const registeredCount = availableProviders.length;

    // Fetch latest stats from DB to prioritize
    let dbStats: (typeof schema.aiProviders.$inferSelect)[] = [];
    let unroutable = { skippedAuthCooldown: 0, skippedTemporary: 0, skippedDisabledInDb: 0 };
    try {
        dbStats = await db.select().from(schema.aiProviders);
        unroutable = this.countUnroutableReasons(availableProviders, dbStats);
        availableProviders = this.filterRoutableProviders(availableProviders, dbStats);

        // Same known-dead exclusion as routeTask() - a multi-provider debate shouldn't spend real
        // parallel calls on providers whose keys have already failed repeatedly, unless every
        // enabled provider is in that state (then there's nothing better to fall back to).
        const isKnownDead = (id: string) => dbStats.find(s => s.id === id)?.health === 'Offline';
        const live = availableProviders.filter(([id]) => !isKnownDead(id));
        if (live.length > 0) availableProviders = live;

        availableProviders.sort((a, b) => {
           const statA = dbStats.find(s => s.id === a[0]);
           const statB = dbStats.find(s => s.id === b[0]);
           if (statA && statB) {
               if (statA.priority !== statB.priority) return (statA.priority ?? 99) - (statB.priority ?? 99);
               if (statA.health === 'Healthy' && statB.health !== 'Healthy') return -1;
               if (statB.health === 'Healthy' && statA.health !== 'Healthy') return 1;
               if ((statA.successRate || 0) !== (statB.successRate || 0)) return (statB.successRate || 0) - (statA.successRate || 0);
               return (statA.latency || 9999) - (statB.latency || 9999);
           }
           return 0;
        });
    } catch (e) {}
    availableProviders = selectConsensusProviders(availableProviders, tradingSafety.consensusMaxProviders);

    if (availableProviders.length === 0) {
       const message = describeConsensusProvidersUnavailable({ registeredCount, ...unroutable });
       this.emitProvidersExhausted({ agentType, providersAttempted: [], lastError: message, shortCircuit: true, registeredCount, ...unroutable });
       throw new Error(message);
    }

    const start = Date.now();
    const promises = availableProviders.map(async ([providerId, provider]) => {
        const pStart = Date.now();
        try {
            if (!(await provider.authenticate())) {
                return { provider: providerId, status: "error", error: "Not authenticated", latency: 0 };
            }
            
            // Format prompt for consensus format
            const fullPrompt = prompt + "\n\nIMPORTANT: You must return a strict JSON object with this format (no markdown code blocks):\n{\n  \"decision\": \"BUY\" | \"SELL\" | \"HOLD\",\n  \"confidence\": 0-100,\n  \"reasoning\": \"Detailed explanation...\",\n  \"supportingFactors\": [\"fact1\"],\n  \"risks\": [\"risk1\"]\n}";
            
            // Consensus/debate uses researchTimeoutMs so slow inference fails closed without blocking.
            const res = await withTimeout((signal) => provider.chat(fullPrompt, { model: undefined, temperature: AI_DECISION_TEMPERATURE, signal }), RESEARCH_TIMEOUT_MS, providerId);
            const latency = Date.now() - pStart;
            
            // Log usage
            try {
                const callCost = provider.estimateCost(res.inputTokens || 0, res.outputTokens ?? res.tokens);
                eventBus.publish('UI_UPDATE', { type: 'ai_metrics_update', payload: {
                                provider: providerId, providerName: dbStats.find(s => s.id === providerId)?.providerName || providerId,
                                model: 'consensus', agent: agentType, latency, tokens: res.tokens, success: true, cost: callCost,
                                local: isLocalProviderRow(dbStats.find(s => s.id === providerId))
                            } });
                await db.insert(schema.aiUsage).values({
                    id: uuidv4(),
                    timestamp: new Date().toISOString(),
                    provider: providerId,
                    model: 'consensus',
                    agent: agentType,
                    promptTokens: res.inputTokens || 0,
                    completionTokens: res.outputTokens ?? res.tokens,
                    latency,
                    cost: callCost,
                    responseStatus: 'success'
                });
            } catch (e) {}

            let parsed: any = {};
            try {
               let cleanText = res.content.trim();
               if (cleanText.startsWith('```json')) cleanText = cleanText.substring(7);
               if (cleanText.startsWith('```')) cleanText = cleanText.substring(3);
               if (cleanText.endsWith('```')) cleanText = cleanText.substring(0, cleanText.length - 3);
               parsed = JSON.parse(cleanText.trim());
            } catch (e) {
               // Fallback parsing
               parsed = { decision: res.content.toUpperCase().includes("BUY") ? "BUY" : res.content.toUpperCase().includes("SELL") ? "SELL" : "HOLD", confidence: 50, reasoning: res.content, supportingFactors: [], risks: [] };
            }

            const aiCallId = await logAiCall({
                traceId, agent: agentType, provider: providerId, model: 'consensus',
                prompt: fullPrompt, rawResponse: res.content, parsedResponse: JSON.stringify(parsed),
                tokensIn: res.inputTokens || 0, tokensOut: res.outputTokens ?? res.tokens,
                cost: provider.estimateCost(res.inputTokens || 0, res.outputTokens ?? res.tokens),
                latencyMs: latency, status: 'success',
            });

            // Hardening pass, Phase 5: decision/confidence previously passed through unvalidated
            // (`parsed.decision || "HOLD"` only guards against a falsy value, not an off-schema
            // string; `parsed.confidence || 0` doesn't clamp range at all). This method's own
            // consensus math below (`buyWeight += r.confidence`, compared against `> 50`) already
            // assumes a real 0-100 scale and a real BUY/SELL/HOLD decision - validated here to
            // match that existing convention exactly, not renormalized to the different 0-1 scale
            // TRADE_IDEA_GENERATED uses elsewhere.
            return {
                decision: coerceEnum(parsed.decision, TRADE_SIDE_VALUES, 'HOLD'),
                confidence: clampScore(parsed.confidence, 0, 100, 0),
                reasoning: coerceString(parsed.reasoning, res.content),
                supportingFactors: coerceStringArray(parsed.supportingFactors),
                risks: coerceStringArray(parsed.risks),
                model: 'default',
                provider: providerId,
                latencyMs: latency,
                tokenUsage: { input: res.inputTokens || 0, output: res.outputTokens ?? res.tokens },
                status: "success",
                aiCallId,
            };
        } catch(e:any) {
            // Log failure
            try {
                await db.insert(schema.aiUsage).values({
                    id: uuidv4(),
                    timestamp: new Date().toISOString(),
                    provider: providerId,
                    model: 'consensus',
                    agent: agentType,
                    promptTokens: 0,
                    completionTokens: 0,
                    latency: Date.now() - pStart,
                    cost: 0,
                    responseStatus: `error: ${e.message}`
                });
            } catch (err) {}
            const aiCallId = await logAiCall({
                traceId, agent: agentType, provider: providerId, model: 'consensus',
                status: 'error', error: e.message, latencyMs: Date.now() - pStart,
            });
            this.noteProviderSkipFromError(providerId, e);
            return { provider: providerId, status: "error", error: e.message, latencyMs: Date.now() - pStart, aiCallId };
        }
    });

    const results = await Promise.all(promises);
    const successfulResults = results.filter(r => r.status === "success");
    
    // Determine overall verdict
    let buyWeight = 0;
    let sellWeight = 0;
    
    successfulResults.forEach(r => {
       if (r.decision === "BUY") buyWeight += r.confidence;
       if (r.decision === "SELL") sellWeight += r.confidence;
    });

    let verdict = "HOLD";
    if (buyWeight > sellWeight && buyWeight > 50) verdict = "BUY";
    if (sellWeight > buyWeight && sellWeight > 50) verdict = "SELL";

    return {
        consensus_verdict: verdict,
        latency_ms: Date.now() - start,
        // successCount is the honest model-participation count for anything downstream that
        // reports "based on N models" - results (below) intentionally still includes failed/timed
        // out attempts too, for cost/telemetry consumers that need the raw per-provider outcome.
        successCount: successfulResults.length,
        results
    };
  }

  public async routeTask(agentType: string, prompt: string, traceId: string, jsonMode: boolean = false): Promise<{content: string, provider: string, latency: number, aiCallId?: string, model?: string, tokensIn?: number, tokensOut?: number}> {
    if (!allowAiCall()) {
      eventBus.emit(EVENTS.AI_RATE_LIMITED, {
        reason: 'MAX_AI_CALLS_PER_MINUTE',
        agentType,
        traceId,
        ...getPipelineRateSnapshot(),
      });
      const content = jsonMode
        ? '{"side":"HOLD","confidence":0,"reasoning":"AI_RATE_LIMITED"}'
        : 'AI_RATE_LIMITED';
      return { content, provider: 'throttled', latency: 0 };
    }

    let preferredConfig = this.agentRouting.get(agentType);
    
    // Sort providers by priority (lowest number is highest priority), then success rate, then latency
    let availableProviders = Array.from(this.providers.entries());
    
    // Fetch latest stats from DB to prioritize
    let dbStats: (typeof schema.aiProviders.$inferSelect)[] = [];
    try {
        dbStats = await db.select().from(schema.aiProviders);
        availableProviders = this.filterRoutableProviders(availableProviders, dbStats);
        availableProviders.sort((a, b) => {
           const statA = dbStats.find(s => s.id === a[0]);
           const statB = dbStats.find(s => s.id === b[0]);
           if (statA && statB) {
               // Prefer local / free tiers first if configured
               if (statA.priority !== statB.priority) return (statA.priority ?? 99) - (statB.priority ?? 99);
               // Healthy > Degraded
               if (statA.health === 'Healthy' && statB.health !== 'Healthy') return -1;
               if (statB.health === 'Healthy' && statA.health !== 'Healthy') return 1;
               // Success rate
               if ((statA.successRate || 0) !== (statB.successRate || 0)) return (statB.successRate || 0) - (statA.successRate || 0);
               // Latency
               return (statA.latency || 9999) - (statB.latency || 9999);
           }
           return 0;
        });

        // Providers real calls have already driven to 'Offline' (successRate decayed below 50
        // from repeated real failures - see the failure branch below) are excluded when any
        // live provider remains. Same policy as routeConsensus: do not burn last-resort
        // round-trips on a 404/dead endpoint every NewsAgent cycle.
        const isKnownDead = (id: string) => dbStats.find(s => s.id === id)?.health === 'Offline';
        const live = availableProviders.filter(([id]) => !isKnownDead(id));
        if (live.length > 0) availableProviders = live;
    } catch (e) {}

    // If agent has a preferred provider, put it first
    if (preferredConfig) {
        const prefIdx = availableProviders.findIndex(p => p[0] === preferredConfig!.providerId);
        if (prefIdx > 0) {
            const pref = availableProviders.splice(prefIdx, 1)[0];
            availableProviders.unshift(pref);
        }
    }
    
    if (availableProviders.length === 0) {
       const unroutable = this.countUnroutableReasons(Array.from(this.providers.entries()), dbStats);
       const message = describeConsensusProvidersUnavailable({
         registeredCount: this.providers.size,
         ...unroutable,
       });
       this.emitProvidersExhausted({ agentType, providersAttempted: [], lastError: message, shortCircuit: true });
       const content = jsonMode
         ? '{"side":"HOLD","confidence":0,"reasoning":"NO_ROUTABLE_AI_PROVIDERS"}'
         : '{"error": "No routable AI Providers"}';
       return { content, provider: 'throttled', latency: 0 };
    }

    let lastError: Error | null = null;
    const failedProviders: { id: string; reason: string }[] = [];
    
    for (const [providerId, provider] of availableProviders) {
        if (!(await provider.authenticate())) {
             console.log(`[AIRouter] Provider ${providerId} not authenticated, skipping...`);
             continue;
        }

        const startTime = Date.now();
        let reqModel: string | undefined;
        let latency = 0;
        let res: any;
        try {
            console.log(`[AIRouter] Agent '${agentType}' routing to ${providerId}`);
            
            reqModel = (providerId === preferredConfig?.providerId) ? preferredConfig?.model : undefined;
            // When this call is going through the agentType's routed model (config/aiModels.json
            // or a persisted override sharing the same agentType), use that route's own
            // temperature/timeout/fallback-model list instead of the generic defaults - additive,
            // every other agent/provider combination behaves exactly as before.
            const route = aiModels.routes[agentType];
            const providerRow = dbStats.find(s => s.id === providerId);
            // Ollama model-name fallbacks (fingpt → plutus → llama3.2) must not run on NVIDIA
            // or other remotes — each 404 was billed against NewsAgent's 12s×3 = 36s outer budget.
            const fallbackModels = (reqModel && isLocalProviderRow(providerRow)) ? route?.fallback : undefined;
            const researchBound = isResearchAgentType(agentType);
            // Hard outer cap: researchTimeoutMs (8s) for every agent inference — fail-closed HOLD,
            // never stall the event loop on hung Ollama/heavy-mutex queues.
            const hardCapMs = RESEARCH_TIMEOUT_MS;
            const perModelTimeoutMs = Math.min(
              researchBound
                ? (route?.timeoutMs ?? RESEARCH_TIMEOUT_MS)
                : (route?.timeoutMs ?? AI_PROVIDER_TIMEOUT_MS),
              hardCapMs,
            );
            const effectiveTemperature = route?.temperature ?? AI_DECISION_TEMPERATURE;
            // No fallback multiplier stretch past hardCap — one attempt budget only.
            const totalTimeoutMs = hardCapMs;
            res = await withTimeout((signal) => provider.chat(prompt, { model: reqModel, jsonMode, temperature: effectiveTemperature, signal, fallbackModels, timeoutMs: route ? perModelTimeoutMs : undefined }), totalTimeoutMs, providerId);
            
            latency = Date.now() - startTime;
            
            // Log usage to DB
            try {
                const callCost = provider.estimateCost(res.inputTokens || 0, res.outputTokens ?? res.tokens);
                // Broadcast to UI
                try {
                   eventBus.publish('UI_UPDATE', { type: 'ai_metrics_update', payload: {
                                   provider: providerId, providerName: dbStats.find(s => s.id === providerId)?.providerName || providerId,
                                   model: reqModel || 'default', agent: agentType, latency, tokens: res ? res.tokens : 0, success: true, cost: callCost,
                                   local: isLocalProviderRow(dbStats.find(s => s.id === providerId))
                               } });
                } catch(e) {}
                await db.insert(schema.aiUsage).values({
                    id: uuidv4(),
                    timestamp: new Date().toISOString(),
                    provider: providerId,
                    model: reqModel || 'default',
                    agent: agentType,
                    promptTokens: res.inputTokens || 0,
                    completionTokens: res.outputTokens ?? res.tokens,
                    latency,
                    cost: callCost,
                    responseStatus: 'success'
                });

                // Update provider stats
                const pDb = await db.select().from(schema.aiProviders).where(eq(schema.aiProviders.id, providerId));
                if (pDb && pDb.length > 0) {
                    const prevLatency = pDb[0].latency || latency;
                    const newLatency = (prevLatency * 9 + latency) / 10;
                    const prevSuccess = pDb[0].successRate || 100;
                    const newSuccess = Math.min(100, prevSuccess + 1);

                    await db.update(schema.aiProviders).set({
                       latency: newLatency,
                       successRate: newSuccess,
                       health: 'Healthy',
                       lastSuccess: new Date().toISOString(),
                       requests: (pDb[0].requests || 0) + 1,
                       tokens: (pDb[0].tokens || 0) + res.tokens,
                       inputTokens: (pDb[0].inputTokens || 0) + (res.inputTokens || 0),
                       outputTokens: (pDb[0].outputTokens || 0) + (res.outputTokens ?? res.tokens),
                       cost: (pDb[0].cost || 0) + callCost,
                    }).where(eq(schema.aiProviders.id, providerId));
                }
            } catch (e) { console.error("Failed to log usage", e); }

            const aiCallId =             await logAiCall({
                traceId,
                agent: agentType,
                provider: providerId,
                model: reqModel || 'default',
                prompt,
                rawResponse: res.content,
                tokensIn: res.inputTokens || 0,
                tokensOut: res.outputTokens ?? res.tokens,
                cost: provider.estimateCost(res.inputTokens || 0, res.outputTokens ?? res.tokens),
                latencyMs: latency,
                status: 'success',
            });

            if (failedProviders.length > 0) {
                const from = failedProviders[failedProviders.length - 1];
                eventBus.emit('MODEL_FALLBACK', {
                    fromProvider: from.id,
                    toProvider: providerId,
                    reason: from.reason,
                    agentType,
                    traceId,
                    failedProviders,
                });
            }

            return { content: res.content, provider: providerId, latency, aiCallId, model: reqModel || 'default', tokensIn: res.inputTokens || 0, tokensOut: res.outputTokens ?? res.tokens };
        } catch (e: any) {
            console.warn(`[AIRouter] Provider ${providerId} failed: ${e.message}. Failing over...`);
            lastError = e;
            failedProviders.push({ id: providerId, reason: e.message });
            const status = extractHttpStatus(e);
            if (status === 401 || status === 403 || isAuthFailureError(e)) {
              await this.disableProviderForAuthFailure(providerId, e.message);
            } else {
              this.noteProviderSkipFromError(providerId, e);
            }
            // Record failure in usage log
            try {
                // Broadcast to UI
                try {
                   eventBus.publish('UI_UPDATE', { type: 'ai_metrics_update', payload: {
                                   provider: providerId, providerName: dbStats.find(s => s.id === providerId)?.providerName || providerId,
                                   model: reqModel || 'default', agent: agentType, latency, tokens: res ? res.tokens : 0, success: false, cost: 0,
                                   local: isLocalProviderRow(dbStats.find(s => s.id === providerId))
                               } });
                } catch(e) {}
                await db.insert(schema.aiUsage).values({
                    id: uuidv4(),
                    timestamp: new Date().toISOString(),
                    provider: providerId,
                    model: 'default',
                    agent: agentType,
                    promptTokens: 0,
                    completionTokens: 0,
                    latency: Date.now() - startTime,
                    cost: 0,
                    responseStatus: `error: ${e.message}`
                });
                
                // Update provider health
                const pDb = await db.select().from(schema.aiProviders).where(eq(schema.aiProviders.id, providerId));
                if (pDb && pDb.length > 0) {
                    const prevSuccess = pDb[0].successRate || 100;
                    const newSuccess = Math.max(0, prevSuccess - 5);
                    const health = newSuccess < 50 ? 'Offline' : 'Degraded';
                    await db.update(schema.aiProviders).set({
                       successRate: newSuccess,
                       health,
                       lastFailure: new Date().toISOString()
                    }).where(eq(schema.aiProviders.id, providerId));
                }
            } catch (err) {}
            await logAiCall({
                traceId,
                agent: agentType,
                provider: providerId,
                model: reqModel || 'default',
                prompt,
                status: 'error',
                error: e.message,
                latencyMs: Date.now() - startTime,
            });
            continue; // try next provider
        }
    }
    
    // Phase 12 (ARGUS_PRE_IMPLEMENTATION_BASELINE.md) - real event, previously nothing emitted
    // here at all. AlertingService.ts is the first real consumer - a real "every AI provider is
    // down" signal an operator should know about, not just a per-agent log line each agent's own
    // try/catch already swallows independently.
    this.emitProvidersExhausted({ agentType, providersAttempted: availableProviders.map(([id]) => id), lastError: lastError?.message ?? null });
    throw new Error(`All AI providers failed for task ${agentType}. Last error: ${lastError?.message}`);
  }
}
