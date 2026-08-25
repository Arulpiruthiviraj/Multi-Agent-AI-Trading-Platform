/**
 * ==========================================================
 * Module:
 * GeminiProvider.ts
 *
 * Purpose:
 * Core implementation and logic for the GeminiProvider.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for GeminiProvider
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
import { GoogleGenAI } from '@google/genai';
import { EncryptionService } from '../../core/EncryptionService';
import { aiModels } from '../../config/aiModels';

// Hardening pass, Phase 6: this provider previously hardcoded 'gemini-2.5-flash' and silently
// ignored options.model entirely - AIRouter.setAgentRoute()/routeTask() already built and passed
// a real per-agent model override (`{model: reqModel}`) that never actually reached the API call.
// Real, published Gemini model IDs this provider is willing to route to - an override outside
// this list is rejected (falls back to the default, with a warning) rather than silently
// executing against a model name that might not exist or might behave unexpectedly.
const DEFAULT_MODEL = 'gemini-2.5-flash';
const SUPPORTED_MODELS = new Set([DEFAULT_MODEL, 'gemini-2.5-pro', 'gemini-1.5-pro', 'gemini-1.5-flash']);

export class GeminiProvider extends BaseAIProvider {
  private ai: GoogleGenAI | null = null;

  constructor() {
    super();
    this.providerName = 'Gemini';
  }

  async initialize(apiKey?: string): Promise<void> {
    const key = apiKey || process.env.GEMINI_API_KEY;
    if (key) {
        this.ai = new GoogleGenAI({ apiKey: key });
    }
  }

  async authenticate(): Promise<boolean> {
    return this.ai !== null;
  }

  async chat(prompt: string, options?: any): Promise<{ content: string, tokens: number, inputTokens?: number, outputTokens?: number }> {
    if (!this.ai) throw new Error("GeminiProvider not authenticated");
    let model = DEFAULT_MODEL;
    if (options?.model) {
      if (SUPPORTED_MODELS.has(options.model)) {
        model = options.model;
      } else {
        console.warn(`[GeminiProvider] Requested model '${options.model}' is not in this provider's supported list - falling back to ${DEFAULT_MODEL} rather than silently executing against an unverified model name.`);
      }
    }
    const response = await this.ai.models.generateContent({
        model,
        contents: prompt,
        // Real bug found live (2026-08-24) - see OpenAICompatibleProvider.ts's identical comment;
        // maxOutputTokens is always set now (previously the whole `config` block, including this,
        // was only included when a caller passed temperature/signal - Gemini's own SDK default is
        // otherwise unbounded).
        config: {
          maxOutputTokens: aiModels.maxResponseTokens,
          ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options?.signal ? { abortSignal: options.signal } : {}),
        },
    });
    // Real usage split from the SDK's own response - previously hardcoded to 0 regardless of
    // the fact that usageMetadata was already available on every response.
    const inputTokens = response.usageMetadata?.promptTokenCount || 0;
    const outputTokens = response.usageMetadata?.candidatesTokenCount || 0;
    return {
        content: response.text || '',
        tokens: response.usageMetadata?.totalTokenCount || (inputTokens + outputTokens),
        inputTokens,
        outputTokens,
    };
  }

  // Public list price for gemini-2.5-flash as of Google's published AI Studio pricing - verify
  // against ai.google.dev/pricing before relying on this for budget decisions; prices change.
  estimateCost(inputTokens: number, outputTokens: number): number {
    const inputPer1M = 0.30;
    const outputPer1M = 2.50;
    return (inputTokens / 1_000_000) * inputPer1M + (outputTokens / 1_000_000) * outputPer1M;
  }

  supportsTools(): boolean { return true; }
  supportsStructuredOutput(): boolean { return true; }
  supportsStreaming(): boolean { return true; }
}
