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
    
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
            model: "gpt-4o",
            messages: [{ role: "user", content: prompt }]
        })
    });
    
    if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.statusText}`);
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
