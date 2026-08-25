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
import { heavyModelMutex } from './../HeavyModelMutex';
import { aiModels } from './../../config/aiModels';

/**
 * DeepSeek R1 (and other reasoning-tuned local models) prefix their real answer with a
 * `<think>...</think>` chain-of-thought block. Every consumer of `.content` downstream expects
 * clean JSON/text, not that reasoning preamble - stripped once, centrally, here (the one place
 * ANY Ollama-served model's raw content passes through), rather than patched into every agent
 * that happens to call a reasoning model.
 */
export function stripThinkTags(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

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

  /** One real HTTP attempt against exactly `model` - the pre-existing 429/5xx/network retry loop,
   *  unchanged, just parameterized so chat() can call it once per fallback model. */
  private async chatOnce(model: string, prompt: string, options: any, headers: Record<string, string>): Promise<{ content: string, tokens: number, inputTokens?: number, outputTokens?: number }> {
    let retries = 0;
    const maxRetries = 2;
    let delay = 500;

    // Ollama's OpenAI-compatible endpoint honors response_format:{type:"json_object"} and
    // constrains decoding to valid JSON - this measurably cuts the invalid-JSON failure rate
    // small local models otherwise have on structured-extraction tasks (see NewsScoringEngine).
    // Scoped to local backends only - not every OpenAI-compatible aggregator supports this param,
    // and a paid call failing on an unsupported param would be a worse outcome than skipping it.
    const body: Record<string, any> = {
        model,
        messages: [{ role: "user", content: prompt }],
        // Real bug found live (2026-08-24): no provider ever capped output tokens, so every call
        // implicitly requested the model's full max output (e.g. 16384 for gpt-4o via OpenRouter).
        // A low-balance OpenRouter account got a genuine 402 "requires more credits, or fewer
        // max_tokens" even though the key itself authenticated fine. Argus responses are short
        // structured JSON - config/aiModels.json's maxResponseTokens caps this for every backend.
        max_tokens: aiModels.maxResponseTokens,
    };
    if (options?.jsonMode && this.isLocal) {
        body.response_format = { type: 'json_object' };
    }
    // Phase 7 - see OpenAIProvider.ts's identical comment. Additive, opt-in only.
    if (options?.temperature !== undefined) {
        body.temperature = options.temperature;
    }
    // Real memory-management hint for local Ollama specifically - lets Ollama unload an inactive
    // 14B model after this many idle minutes instead of holding it (and its VRAM) resident
    // forever. No-op for non-Ollama OpenAI-compatible backends, which don't read this field.
    if (this.isLocal) {
        body.keep_alive = aiModels.ollama.keepAlive;
    }

    while (retries <= maxRetries) {
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers,
            signal: options?.signal,
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
            // Real fix (2026-08-24 readiness audit, Part 5): the thrown message previously carried
            // only `${status} ${statusText}` - e.g. "429 Too Many Requests" - discarding the response
            // body entirely, even when a provider's body clearly distinguishes a genuine rate limit
            // from something more specific (Moonshot's "account ... is suspended due to insufficient
            // balance" is a real example that was otherwise indistinguishable from an ordinary 429).
            // A short body snippet lets AIProviderHealthCheck.ts's classifyError() tell them apart
            // instead of collapsing every non-2xx response into one generic label.
            let bodySnippet = '';
            try { bodySnippet = (await response.text()).slice(0, 300); } catch { /* body already consumed or unavailable - message-only fallback below */ }
            throw new Error(`${this.providerName} API error: ${response.status} ${response.statusText}${bodySnippet ? ` - ${bodySnippet}` : ''}`);
        }

        const data = await response.json();
        const inputTokens = data.usage?.prompt_tokens || 0;
        const outputTokens = data.usage?.completion_tokens || 0;
        return {
            content: stripThinkTags(data.choices[0]?.message?.content || ''),
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

    // Real same-provider model fallback (config/aiModels.json's per-route `fallback` list): if the
    // primary model 404s/errors/times out (e.g. not pulled, or momentarily unavailable under
    // heavy-model contention), retry the SAME request against each fallback model in order before
    // this provider is considered failed - distinct from AIRouter's own cross-provider failover,
    // which only kicks in once every model attempted here has failed.
    const primaryModel = options?.model || this.defaultModel;
    const modelsToTry = [primaryModel, ...(Array.isArray(options?.fallbackModels) ? options.fallbackModels : [])];

    // Real bug fix, found live: every fallback attempt used to share the ONE AbortSignal/deadline
    // AIRouter's outer withTimeout() created for the whole call - once that fired, every
    // subsequent fallback model failed INSTANTLY with "This operation was aborted" rather than
    // getting a real, fresh attempt (confirmed in production logs: llama3.2 and 0xroyce/plutus:latest
    // both failed within the same call with that exact message). When `options.timeoutMs` is
    // provided (AIRouter passes each route's own per-model budget), each model attempt now gets
    // its OWN fresh AbortController/timer - a cold-starting fallback model gets the SAME real
    // time budget the primary model had, not whatever was left over. The externally-supplied
    // signal (if any) can still abort every attempt, e.g. a caller-level cancellation.
    const perModelTimeoutMs: number | undefined = options?.timeoutMs;
    const externalSignal: AbortSignal | undefined = options?.signal;

    let lastError: Error | null = null;
    for (const model of modelsToTry) {
      let controller: AbortController | undefined;
      let timer: NodeJS.Timeout | undefined;
      let onExternalAbort: (() => void) | undefined;
      try {
        let attemptOptions = options;
        if (perModelTimeoutMs) {
          controller = new AbortController();
          timer = setTimeout(() => controller!.abort(), perModelTimeoutMs);
          if (externalSignal) {
            onExternalAbort = () => controller!.abort();
            externalSignal.addEventListener('abort', onExternalAbort);
          }
          attemptOptions = { ...options, signal: controller.signal };
        }
        return await heavyModelMutex.run(model, () => this.chatOnce(model, prompt, attemptOptions, headers));
      } catch (err: any) {
        lastError = err;
        if (modelsToTry.indexOf(model) < modelsToTry.length - 1) {
          console.warn(`[${this.providerName}] Model '${model}' failed (${err.message}) - trying fallback model.`);
        }
      } finally {
        if (timer) clearTimeout(timer);
        if (externalSignal && onExternalAbort) externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }
    throw lastError ?? new Error(`${this.providerName} failed after retries`);
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
