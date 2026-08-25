/**
 * ==========================================================
 * Module:
 * DeepSeekProvider.ts
 *
 * Purpose:
 * Core implementation and logic for the DeepSeekProvider.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for DeepSeekProvider
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
// hardcoded "deepseek-coder" and silently ignored options.model.
const DEFAULT_MODEL = 'deepseek-coder';
const SUPPORTED_MODELS = new Set([DEFAULT_MODEL, 'deepseek-chat', 'deepseek-reasoner']);

export class DeepSeekProvider extends BaseAIProvider {
  public apiKey: string = '';

  constructor() {
    super();
    this.providerName = 'DeepSeek';
  }

  async initialize(apiKey?: string): Promise<void> {
    const key = apiKey || (process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY);
    if (key) { this.apiKey = key; }
  }

  async authenticate(): Promise<boolean> {
    return !!this.apiKey;
  }

  async chat(prompt: string, options?: any): Promise<{ content: string, tokens: number, inputTokens?: number, outputTokens?: number }> {
    if (!this.apiKey) throw new Error("DeepSeekProvider not authenticated");

    let model = DEFAULT_MODEL;
    if (options?.model) {
      if (SUPPORTED_MODELS.has(options.model)) {
        model = options.model;
      } else {
        console.warn(`[DeepSeekProvider] Requested model '${options.model}' is not in this provider's supported list - falling back to ${DEFAULT_MODEL} rather than silently executing against an unverified model name.`);
      }
    }

    const response = await fetch(networkEndpoints.aiCloud.deepSeekChatCompletionsUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.apiKey}`
        },
        signal: options?.signal,
        body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            // Phase 7 - see OpenAIProvider.ts's identical comment. Additive, opt-in only.
            ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
            // Real bug found live (2026-08-24) - see OpenAICompatibleProvider.ts's identical comment.
            max_tokens: aiModels.maxResponseTokens,
        })
    });

    if (!response.ok) {
        // Real fix (2026-08-24 readiness audit, Part 5) - see OpenAICompatibleProvider.ts's identical comment.
        let bodySnippet = '';
        try { bodySnippet = (await response.text()).slice(0, 300); } catch { /* body already consumed or unavailable */ }
        throw new Error(`DeepSeek API error: ${response.status} ${response.statusText}${bodySnippet ? ` - ${bodySnippet}` : ''}`);
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

  // Public list price for deepseek-chat (cache-miss rate) as of DeepSeek's published API
  // pricing - verify against platform.deepseek.com/api-docs/pricing before relying on this for
  // budget decisions; DeepSeek has historically changed these rates and offered off-peak discounts.
  estimateCost(inputTokens: number, outputTokens: number): number {
    const inputPer1M = 0.14;
    const outputPer1M = 0.28;
    return (inputTokens / 1_000_000) * inputPer1M + (outputTokens / 1_000_000) * outputPer1M;
  }
}
