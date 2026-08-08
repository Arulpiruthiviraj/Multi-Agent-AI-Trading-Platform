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

  async chat(prompt: string, options?: any): Promise<{ content: string, tokens: number }> {
    if (!this.ai) throw new Error("GeminiProvider not authenticated");
    const response = await this.ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt
    });
    return {
        content: response.text || '',
        tokens: 0 // Ideally from response.usageMetadata
    };
  }

  supportsTools(): boolean { return true; }
  supportsStructuredOutput(): boolean { return true; }
  supportsStreaming(): boolean { return true; }
}
