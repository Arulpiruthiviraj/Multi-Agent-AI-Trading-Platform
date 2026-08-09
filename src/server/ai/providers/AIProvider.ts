/**
 * ==========================================================
 * Module:
 * AIProvider.ts
 *
 * Purpose:
 * Core implementation and logic for the AIProvider.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for AIProvider
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

export interface AIProvider {
  initialize(apiKey?: string): Promise<void>;
  authenticate(): Promise<boolean>;
  // inputTokens/outputTokens are the real split from the provider's own usage field when
  // available. tokens is kept as inputTokens+outputTokens for backward compatibility with
  // existing callers that only look at the combined count.
  chat(prompt: string, options?: any): Promise<{ content: string, tokens: number, inputTokens?: number, outputTokens?: number }>;
  stream(prompt: string, options?: any): AsyncGenerator<string, void, unknown>;
  embeddings(text: string): Promise<number[]>;
  vision(image: Buffer, prompt: string): Promise<{ content: string, tokens: number }>;
  image(prompt: string): Promise<Buffer>;
  health(): Promise<string>;
  estimateCost(inputTokens: number, outputTokens: number): number;
  estimateLatency(): number;
  supportsTools(): boolean;
  supportsReasoning(): boolean;
  supportsVision(): boolean;
  supportsStructuredOutput(): boolean;
  supportsStreaming(): boolean;
}

export abstract class BaseAIProvider implements AIProvider {
  protected providerName: string = 'Base';

  async initialize(apiKey?: string): Promise<void> {}
  async authenticate(): Promise<boolean> { return true; }
  async chat(prompt: string, options?: any): Promise<{ content: string, tokens: number, inputTokens?: number, outputTokens?: number }> { return { content: '', tokens: 0, inputTokens: 0, outputTokens: 0 }; }
  async *stream(prompt: string, options?: any): AsyncGenerator<string, void, unknown> { yield ''; }
  async embeddings(text: string): Promise<number[]> { return []; }
  async vision(image: Buffer, prompt: string): Promise<{ content: string, tokens: number }> { return { content: '', tokens: 0 }; }
  async image(prompt: string): Promise<Buffer> { return Buffer.from(''); }
  async health(): Promise<string> { return 'Healthy'; }
  estimateCost(inputTokens: number, outputTokens: number): number { return 0; }
  estimateLatency(): number { return 100; }
  supportsTools(): boolean { return false; }
  supportsReasoning(): boolean { return false; }
  supportsVision(): boolean { return false; }
  supportsStructuredOutput(): boolean { return false; }
  supportsStreaming(): boolean { return false; }
}
