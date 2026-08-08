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
            { id: uuidv4(), providerName: 'OpenRouter (Free Tier)', apiEndpoint: 'https://openrouter.ai/api/v1', priority: 1, enabled: true },
            { id: uuidv4(), providerName: 'LiteLLM Gateway', apiEndpoint: 'http://localhost:4000', priority: 2, enabled: true },
            { id: uuidv4(), providerName: 'Ollama (Local)', apiEndpoint: 'http://localhost:11434/v1', priority: 3, enabled: true },
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
  }
  
  public setAgentRoute(agentType: string, providerId: string, model: string) {
     this.agentRouting.set(agentType, { providerId, model });
  }

  
  public async routeConsensus(agentType: string, prompt: string, traceId: string): Promise<any> {
    let availableProviders = Array.from(this.providers.entries());
    
    // Fetch latest stats from DB to prioritize
    try {
        const dbStats = await db.select().from(schema.aiProviders);
        availableProviders = availableProviders.filter(([id, p]) => {
           const stat = dbStats.find(s => s.id === id);
           return !stat || stat.enabled;
        });
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
                eventBus.publish('UI_UPDATE', { type: 'ai_metrics_update', payload: {
                                provider: providerId, model: 'consensus', agent: agentType, latency, tokens: res.tokens, success: true
                            } });
                await db.insert(schema.aiUsage).values({
                    id: uuidv4(),
                    timestamp: new Date().toISOString(),
                    provider: providerId,
                    model: 'consensus',
                    agent: agentType,
                    promptTokens: 0,
                    completionTokens: res.tokens,
                    latency,
                    cost: provider.estimateCost(0, res.tokens),
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

            return {
                decision: parsed.decision || "HOLD",
                confidence: parsed.confidence || 0,
                reasoning: parsed.reasoning || res.content,
                supportingFactors: parsed.supportingFactors || [],
                risks: parsed.risks || [],
                model: 'default',
                provider: providerId,
                latencyMs: latency,
                tokenUsage: { input: 0, output: res.tokens },
                status: "success"
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
            return { provider: providerId, status: "error", error: e.message, latencyMs: Date.now() - pStart };
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

  public async routeTask(agentType: string, prompt: string, traceId: string): Promise<{content: string, provider: string, latency: number}> {
    
    let preferredConfig = this.agentRouting.get(agentType);
    
    // Sort providers by priority (lowest number is highest priority), then success rate, then latency
    let availableProviders = Array.from(this.providers.entries());
    
    // Fetch latest stats from DB to prioritize
    try {
        const dbStats = await db.select().from(schema.aiProviders);
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
            res = await provider.chat(prompt, { model: reqModel });
            
            latency = Date.now() - startTime;
            
            // Log usage to DB
            try {
                // Broadcast to UI
                try {
                   eventBus.publish('UI_UPDATE', { type: 'ai_metrics_update', payload: {
                                   provider: providerId, model: reqModel || 'default', agent: agentType, latency, tokens: res ? res.tokens : 0, success: true
                               } });
                } catch(e) {}
                await db.insert(schema.aiUsage).values({
                    id: uuidv4(),
                    timestamp: new Date().toISOString(),
                    provider: providerId,
                    model: reqModel || 'default',
                    agent: agentType,
                    promptTokens: 0,
                    completionTokens: res.tokens,
                    latency,
                    cost: provider.estimateCost(0, res.tokens),
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
                       tokens: (pDb[0].tokens || 0) + res.tokens
                    }).where(eq(schema.aiProviders.id, providerId));
                }
            } catch (e) { console.error("Failed to log usage", e); }
            
            return { content: res.content, provider: providerId, latency };
        } catch (e: any) {
            console.warn(`[AIRouter] Provider ${providerId} failed: ${e.message}. Failing over...`);
            lastError = e;
            // Record failure in usage log
            try {
                // Broadcast to UI
                try {
                   eventBus.publish('UI_UPDATE', { type: 'ai_metrics_update', payload: {
                                   provider: providerId, model: reqModel || 'default', agent: agentType, latency, tokens: res ? res.tokens : 0, success: false
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
            continue; // try next provider
        }
    }
    
    throw new Error(`All AI providers failed for task ${agentType}. Last error: ${lastError?.message}`);
  }
}
