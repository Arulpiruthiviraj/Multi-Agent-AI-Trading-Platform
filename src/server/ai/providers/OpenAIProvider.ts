/**
 * ==========================================================
 * Module:
 * OpenAIProvider.ts
 *
 * Purpose:
 * Core implementation and logic for the OpenAIProvider.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for OpenAIProvider
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
import { networkEndpoints } from '../../config/networkEndpoints';
import { aiModels } from '../../config/aiModels';

// Hardening pass, Phase 6: see GeminiProvider.ts's identical comment - this provider previously
// hardcoded "gpt-4o" and silently ignored options.model.
// Real cost fix (2026-08-24): every Argus call through this provider is a short structured-JSON
// classification (a side, a confidence, a short reasoning string) - gpt-4o-mini is meaningfully
// cheaper than full gpt-4o for that shape of task with no observed quality requirement for the
// larger model. gpt-4o stays in SUPPORTED_MODELS for any caller that explicitly asks for it.
const DEFAULT_MODEL = 'gpt-4o-mini';
const SUPPORTED_MODELS = new Set([DEFAULT_MODEL, 'gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo']);

export class OpenAIProvider extends BaseAIProvider {
  public apiKey: string = '';

  constructor() {
    super();
    this.providerName = 'OpenAI';
  }

  async initialize(apiKey?: string): Promise<void> {
    const key = apiKey || (process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY);
    if (key) { this.apiKey = key; }
  }

  async authenticate(): Promise<boolean> {
    return !!this.apiKey;
  }

  async chat(prompt: string, options?: any): Promise<{ content: string, tokens: number, inputTokens?: number, outputTokens?: number }> {
    if (!this.apiKey) throw new Error("OpenAIProvider not authenticated");

    let model = DEFAULT_MODEL;
    if (options?.model) {
      if (SUPPORTED_MODELS.has(options.model)) {
        model = options.model;
      } else {
        console.warn(`[OpenAIProvider] Requested model '${options.model}' is not in this provider's supported list - falling back to ${DEFAULT_MODEL} rather than silently executing against an unverified model name.`);
      }
    }

    const response = await fetch(networkEndpoints.aiCloud.openAiChatCompletionsUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.apiKey}`
        },
        signal: options?.signal,
        body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            // Phase 7 (AI_MODEL_INVENTORY.md / ARGUS_SAFETY_HARDENING_REPORT.md) - real,
            // caller-controlled reproducibility knob. Previously no temperature was ever set
            // anywhere in this codebase (default sampling varies by provider/model and is
            // undocumented) - AIRouter.ts now passes a low, deterministic-leaning value for
            // trading-decision prompts. Only included when the caller actually supplies one, so
            // this never changes behavior for any call site that doesn't opt in.
            ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
            // Real bug found live (2026-08-24) - see OpenAICompatibleProvider.ts's identical comment.
            max_tokens: aiModels.maxResponseTokens,
        })
    });

    if (!response.ok) {
        // Real fix (2026-08-24 readiness audit, Part 5): previously dropped both the numeric status
        // code and the response body - "OpenAI API error: Unauthorized" happened to keyword-match
        // isAuthFailureError()'s fallback pattern, but a differently-worded body or a status whose
        // statusText isn't a recognizable keyword would misclassify as UNKNOWN. See
        // OpenAICompatibleProvider.ts's identical comment.
        let bodySnippet = '';
        try { bodySnippet = (await response.text()).slice(0, 300); } catch { /* body already consumed or unavailable */ }
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}${bodySnippet ? ` - ${bodySnippet}` : ''}`);
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
  }

  // Public list price for gpt-4o as of OpenAI's published API pricing - verify against
  // openai.com/api/pricing before relying on this for budget decisions; prices change.
  estimateCost(inputTokens: number, outputTokens: number): number {
    const inputPer1M = 2.50;
    const outputPer1M = 10.00;
    return (inputTokens / 1_000_000) * inputPer1M + (outputTokens / 1_000_000) * outputPer1M;
  }
}
