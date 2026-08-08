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

  async chat(prompt: string, options?: any): Promise<{ content: string, tokens: number }> {
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
    return {
        content: data.choices[0]?.message?.content || '',
        tokens: data.usage?.total_tokens || 0
    };
  }
}
