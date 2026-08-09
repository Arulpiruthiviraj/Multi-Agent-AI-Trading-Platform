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
    
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
            model: "deepseek-coder",
            messages: [{ role: "user", content: prompt }]
        })
    });
    
    if (!response.ok) {
        throw new Error(`DeepSeek API error: ${response.statusText}`);
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
