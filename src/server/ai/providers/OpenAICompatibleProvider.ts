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

  async chat(prompt: string, options?: any): Promise<{ content: string, tokens: number }> {
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

    while (retries <= maxRetries) {
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: options?.model || this.defaultModel,
                messages: [{ role: "user", content: prompt }]
            })
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
        return {
            content: data.choices[0]?.message?.content || '',
            tokens: data.usage?.total_tokens || 0
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
}
