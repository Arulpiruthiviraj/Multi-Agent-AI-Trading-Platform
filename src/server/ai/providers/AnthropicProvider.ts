/**
 * AnthropicProvider - real, dedicated Claude/Anthropic Messages API implementation.
 *
 * Added 2026-08-24 (readiness audit, Part 4): the Anthropic credential was independently proven
 * valid (a direct call to api.anthropic.com/v1/messages authenticated and returned a real
 * completion), but this codebase previously had no dedicated provider for it - "Claude" fell
 * through AIRouter's generic OpenAICompatibleProvider branch, which speaks the OpenAI chat-
 * completions schema (Authorization: Bearer, choices[0].message.content) - not Anthropic's real
 * API (x-api-key header, anthropic-version header, a `content` array of typed blocks in the
 * response). No amount of correct endpoint configuration could have fixed that mismatch; this
 * class exists so Claude gets its own correct request/response handling, same as Gemini/OpenAI/
 * DeepSeek already do.
 *
 * Never: places or influences a trade directly (AIRouter's routeTask/routeConsensus remain the
 * only callers of this class, same as every other provider); accepts a caller-supplied model
 * outside the real, published model list; keep a max_tokens value uncapped (Anthropic's Messages
 * API requires max_tokens on every request, unlike OpenAI's optional field).
 */
import { BaseAIProvider } from './AIProvider';
import { networkEndpoints } from '../../config/networkEndpoints';
import { aiModels } from '../../config/aiModels';

// Real, published Anthropic model IDs (verified live against /v1/models with this session's own
// credential, 2026-08-24) - an override outside this list falls back to the default with a
// warning, matching every other provider's model-validation pattern in this directory.
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const SUPPORTED_MODELS = new Set([
  DEFAULT_MODEL,
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-5-20251101',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-fable-5',
  'claude-sonnet-5',
  'claude-opus-5',
]);

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicMessagesResponse {
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
}

export class AnthropicProvider extends BaseAIProvider {
  private apiKey: string = '';

  constructor() {
    super();
    this.providerName = 'Claude';
  }

  async initialize(apiKey?: string): Promise<void> {
    const key = apiKey || process.env.ANTHROPIC_API_KEY;
    if (key) this.apiKey = key;
  }

  async authenticate(): Promise<boolean> {
    return !!this.apiKey;
  }

  async chat(prompt: string, options?: any): Promise<{ content: string, tokens: number, inputTokens?: number, outputTokens?: number }> {
    if (!this.apiKey) throw new Error('AnthropicProvider not authenticated');

    let model = DEFAULT_MODEL;
    if (options?.model) {
      if (SUPPORTED_MODELS.has(options.model)) {
        model = options.model;
      } else {
        console.warn(`[AnthropicProvider] Requested model '${options.model}' is not in this provider's supported list - falling back to ${DEFAULT_MODEL} rather than silently executing against an unverified model name.`);
      }
    }

    const body: Record<string, any> = {
      model,
      // Anthropic's Messages API requires max_tokens on every request (unlike OpenAI, where it's
      // optional) - config/aiModels.json's maxResponseTokens is the same project-wide cap every
      // other provider now uses (2026-08-24 cost fix).
      max_tokens: aiModels.maxResponseTokens,
      messages: [{ role: 'user', content: prompt }],
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
    };

    const response = await fetch(networkEndpoints.aiCloud.anthropicMessagesUrl, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': networkEndpoints.aiCloud.anthropicApiVersion,
        'Content-Type': 'application/json',
      },
      signal: options?.signal,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // Real fix (2026-08-24 readiness audit, Part 5) - see OpenAICompatibleProvider.ts's identical
      // comment: capture a body snippet so AIProviderHealthCheck.ts's classifyError() can actually
      // distinguish failure classes instead of collapsing every non-2xx response into one label.
      let bodySnippet = '';
      try { bodySnippet = (await response.text()).slice(0, 300); } catch { /* body already consumed or unavailable */ }
      throw new Error(`Claude API error: ${response.status} ${response.statusText}${bodySnippet ? ` - ${bodySnippet}` : ''}`);
    }

    const data = (await response.json()) as AnthropicMessagesResponse;
    // Real response shape: content is an array of typed blocks (text/tool_use/thinking/...) -
    // concatenate only the text blocks, never assume index 0 is the only content (a `thinking`
    // block can legitimately precede the real text block for extended-thinking-capable models).
    const content = (data.content || [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;
    return {
      content,
      tokens: inputTokens + outputTokens,
      inputTokens,
      outputTokens,
    };
  }

  // Public list price for claude-haiku-4-5 as of Anthropic's published pricing - verify against
  // anthropic.com/pricing before relying on this for budget decisions; prices change.
  estimateCost(inputTokens: number, outputTokens: number): number {
    const inputPer1M = 1.00;
    const outputPer1M = 5.00;
    return (inputTokens / 1_000_000) * inputPer1M + (outputTokens / 1_000_000) * outputPer1M;
  }

  supportsTools(): boolean { return true; }
  supportsReasoning(): boolean { return true; }
  supportsStructuredOutput(): boolean { return true; }
  supportsStreaming(): boolean { return true; }
}
