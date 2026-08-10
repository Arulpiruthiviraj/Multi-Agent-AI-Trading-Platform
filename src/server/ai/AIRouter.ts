import { eventBus } from '../core/EventBus';
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

// Whether a provider DB row is a local endpoint - matches the exact same check initialize() uses
// to decide isLocal when constructing an OpenAICompatibleProvider. More reliable than inferring
// "local" from a $0 estimateCost() result, which is also literally 0 for a paid aggregator that
// failed before any tokens were counted (0 tokens -> 0 cost regardless of pricing formula).
function isLocalProviderRow(row: { apiEndpoint: string | null } | undefined): boolean {
  return !!row?.apiEndpoint && (row.apiEndpoint.includes('localhost') || row.apiEndpoint.includes('127.0.0.1'));
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
  return id;
}

export class AIRouter {
  private static instance: AIRouter;
  private providers: Map<string, AIProvider> = new Map();
  // Map agent name to provider and model
  private agentRouting: Map<string, { providerId: string, model: string }> = new Map();

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

  public async initialize() {
     this.providers.clear();
     
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
            { id: uuidv4(), providerName: 'Grok', apiEndpoint: 'https://api.x.ai/v1', priority: 1, enabled: true, defaultModel: 'grok-4' },
            { id: uuidv4(), providerName: 'OpenRouter (Free Tier)', apiEndpoint: 'https://openrouter.ai/api/v1', priority: 2, enabled: true },
            { id: uuidv4(), providerName: 'LiteLLM Gateway', apiEndpoint: 'http://localhost:4000', priority: 3, enabled: true },
            { id: uuidv4(), providerName: 'Ollama (Local)', apiEndpoint: 'http://localhost:11434/v1', priority: 4, enabled: true },
        ];
        try {
            for (const p of defaultProviders) {
               await db.insert(schema.aiProviders).values(p);
            }
            dbProviders = await db.select().from(schema.aiProviders);
        } catch (e) {}
     }
     
     for (const p of dbProviders) {
         if (!p.enabled) continue;
         
         const apiKey = p.apiKeyEncrypted ? EncryptionService.decrypt(p.apiKeyEncrypted) : process.env[`${p.providerName.toUpperCase()}_API_KEY`];
         let providerInstance: AIProvider | null = null;
         
         const nameLower = p.providerName.toLowerCase();
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
             const endpoint = p.apiEndpoint || 'https://openrouter.ai/api/v1';
             const isLocal = endpoint.includes('localhost') || endpoint.includes('127.0.0.1');
             providerInstance = new OpenAICompatibleProvider(p.providerName, endpoint, isLocal);
             await (providerInstance as OpenAICompatibleProvider).initialize(apiKey, p.defaultModel || undefined);
         }
         
         if (providerInstance) {
             this.registerProvider(p.id, providerInstance);
         }
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

    // Fetch latest stats from DB to prioritize
    let dbStats: (typeof schema.aiProviders.$inferSelect)[] = [];
    try {
        dbStats = await db.select().from(schema.aiProviders);
        availableProviders = availableProviders.filter(([id, p]) => {
           const stat = dbStats.find(s => s.id === id);
           return !stat || stat.enabled;
        });

        // Same known-dead exclusion as routeTask() - a multi-provider debate shouldn't spend real
        // parallel calls on providers whose keys have already failed repeatedly, unless every
        // enabled provider is in that state (then there's nothing better to fall back to).
        const isKnownDead = (id: string) => dbStats.find(s => s.id === id)?.health === 'Offline';
        const live = availableProviders.filter(([id]) => !isKnownDead(id));
        if (live.length > 0) availableProviders = live;
    } catch (e) {}

    if (availableProviders.length === 0) {
       throw new Error("No AI Providers available for consensus");
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
            
            const res = await provider.chat(fullPrompt, { model: undefined });
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

            return {
                decision: parsed.decision || "HOLD",
                confidence: parsed.confidence || 0,
                reasoning: parsed.reasoning || res.content,
                supportingFactors: parsed.supportingFactors || [],
                risks: parsed.risks || [],
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
        results
    };
  }

  public async routeTask(agentType: string, prompt: string, traceId: string, jsonMode: boolean = false): Promise<{content: string, provider: string, latency: number, aiCallId?: string, model?: string, tokensIn?: number, tokensOut?: number}> {
    
    let preferredConfig = this.agentRouting.get(agentType);
    
    // Sort providers by priority (lowest number is highest priority), then success rate, then latency
    let availableProviders = Array.from(this.providers.entries());
    
    // Fetch latest stats from DB to prioritize
    let dbStats: (typeof schema.aiProviders.$inferSelect)[] = [];
    try {
        dbStats = await db.select().from(schema.aiProviders);
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
        // from repeated real failures - see the failure branch below) are moved to the very end
        // rather than tried in their normal priority slot. They're still tried last-resort if
        // every live provider fails, but a call no longer burns N dead round-trips (e.g. expired
        // API keys) before reaching a provider that's actually going to answer.
        const isKnownDead = (id: string) => dbStats.find(s => s.id === id)?.health === 'Offline';
        const live = availableProviders.filter(([id]) => !isKnownDead(id));
        const dead = availableProviders.filter(([id]) => isKnownDead(id));
        availableProviders = [...live, ...dead];
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
       return { content: `{"error": "No AI Providers available"}`, provider: 'mock', latency: 10 };
    }

    let lastError: Error | null = null;
    
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
            res = await provider.chat(prompt, { model: reqModel, jsonMode });
            
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

            const aiCallId = await logAiCall({
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

            return { content: res.content, provider: providerId, latency, aiCallId, model: reqModel || 'default', tokensIn: res.inputTokens || 0, tokensOut: res.outputTokens ?? res.tokens };
        } catch (e: any) {
            console.warn(`[AIRouter] Provider ${providerId} failed: ${e.message}. Failing over...`);
            lastError = e;
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
    
    throw new Error(`All AI providers failed for task ${agentType}. Last error: ${lastError?.message}`);
  }
}
