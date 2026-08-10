/**
 * ==========================================================
 * Module:
 * OpenAICompatibleProvider.ts
 *
 * Purpose:
 * Core implementation and logic for the OpenAICompatibleProvider.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for OpenAICompatibleProvider
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

import { BaseAIProvider } from './AIProvider';

export class OpenAICompatibleProvider extends BaseAIProvider {
  public apiKey: string = '';
  public baseUrl: string = '';
  public defaultModel: string = '';
  public isLocal: boolean = false;
  
  constructor(name: string, baseUrl: string, isLocal: boolean = false) {
    super();
    this.providerName = name;
    this.baseUrl = baseUrl;
    this.isLocal = isLocal;
  }

  async initialize(apiKey?: string, defaultModel?: string): Promise<void> {
    this.apiKey = apiKey || '';
    this.defaultModel = defaultModel || 'gpt-3.5-turbo';
  }

  async authenticate(): Promise<boolean> {
    if (this.isLocal) return true;
    return !!this.apiKey;
  }

  async chat(prompt: string, options?: any): Promise<{ content: string, tokens: number, inputTokens?: number, outputTokens?: number }> {
    if (!this.authenticate()) throw new Error(`${this.providerName} not authenticated`);
    
    const headers: Record<string, string> = {
        "Content-Type": "application/json"
    };
    if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    
    // OpenRouter specific headers
    if (this.baseUrl.includes('openrouter.ai')) {
        headers["HTTP-Referer"] = "https://argus.ai";
        headers["X-Title"] = "Argus Trading Terminal";
    }

    let retries = 0;
    const maxRetries = 2;
    let delay = 500;

    // Ollama's OpenAI-compatible endpoint honors response_format:{type:"json_object"} and
    // constrains decoding to valid JSON - this measurably cuts the invalid-JSON failure rate
    // small local models otherwise have on structured-extraction tasks (see NewsScoringEngine).
    // Scoped to local backends only - not every OpenAI-compatible aggregator supports this param,
    // and a paid call failing on an unsupported param would be a worse outcome than skipping it.
    const body: Record<string, any> = {
        model: options?.model || this.defaultModel,
        messages: [{ role: "user", content: prompt }]
    };
    if (options?.jsonMode && this.isLocal) {
        body.response_format = { type: 'json_object' };
    }

    while (retries <= maxRetries) {
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify(body)
        });
        
        if (!response.ok) {
            if (response.status === 429 || response.status >= 500) {
               if (retries < maxRetries) {
                  retries++;
                  await new Promise(resolve => setTimeout(resolve, delay));
                  delay *= 2;
                  continue;
               }
            }
            throw new Error(`${this.providerName} API error: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        const inputTokens = data.usage?.prompt_tokens || 0;
        const outputTokens = data.usage?.completion_tokens || 0;
        return {
            content: data.choices[0]?.message?.content || '',
            tokens: data.usage?.total_tokens || (inputTokens + outputTokens),
            inputTokens,
            outputTokens,
        };
      } catch (err: any) {
         if (retries < maxRetries && (err.message.includes('fetch') || err.message.includes('network'))) {
            retries++;
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2;
            continue;
         }
         throw err;
      }
    }
    throw new Error(`${this.providerName} failed after retries`);
  }

  // This single class serves many different real backends (Grok, OpenRouter, Groq, LiteLLM,
  // Ollama, arbitrary self-hosted endpoints) that each have their own real pricing - it cannot
  // return one universally-correct number. Handles what it can say for certain, and is explicit
  // about the rest rather than returning a flat $0 that's wrong for every paid backend.
  estimateCost(inputTokens: number, outputTokens: number): number {
    if (this.isLocal) return 0; // genuinely free - self-hosted, no metered API call happened

    if (this.baseUrl.includes('x.ai')) {
      // Public list price for grok-4 as of xAI's published API pricing - verify against
      // x.ai/api before relying on this for budget decisions.
      return (inputTokens / 1_000_000) * 3.00 + (outputTokens / 1_000_000) * 15.00;
    }

    // OpenRouter/Groq/other aggregators and arbitrary self-hosted endpoints: real per-model
    // pricing varies by whatever model was actually selected and isn't known generically here.
    // Rather than claim $0 (definitely wrong for a paid aggregator call), use a disclosed,
    // deliberately conservative mid-tier commodity-model estimate so the number's order of
    // magnitude is directionally honest. Add a per-model price table (Phase 11) for exact costs.
    return (inputTokens / 1_000_000) * 0.50 + (outputTokens / 1_000_000) * 1.50;
  }
}
