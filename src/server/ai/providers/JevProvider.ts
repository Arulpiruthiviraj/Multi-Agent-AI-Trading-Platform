/**
 * ==========================================================
 * Module:
 * JevProvider.ts
 *
 * Purpose:
 * AIProvider adapter for TypeSafe AI's Jev — a "System One" decision model.
 * RESEARCH SPIKE (branch research/jev-adapter): not wired into any live
 * decision path. Jev is NOT a chat LLM: it takes a `state` (text/object/array)
 * plus a map of typed questions and returns typed probabilistic answers —
 * yes/no probability (`noul`), a choice distribution (`choice`), or an ordered
 * score (`score`). It generates zero text tokens, so the chat-centric
 * AIProvider methods (chat/stream/embeddings/vision/image) fail closed with a
 * clear error instead of pretending to work.
 *
 * Intended use inside Argus (future, evaluated): cheap first-pass triage for
 * the confidence-gated AI routing layer — e.g. news sentiment classification
 * (bullish/bearish/neutral with calibrated confidence) or trigger gating
 * ("does this setup meet criteria?") — escalating to real LLMs only when
 * Jev's confidence is low. It must NEVER be treated as a reasoning source:
 * independent tests show good calibration on classification but poor
 * answer-quality rating, and "can't hallucinate" means "can't return a value
 * outside your schema" — it can still be confidently wrong within it.
 *
 * Wire format (verified against TypeSafe docs + two independent clients,
 * 2026-10-05):
 *   POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer <API_KEY>
 *   {"model": "jev-latest", "state": <string|object|array>,
 *    "questions": {"<key>": {"type": "noul"|"choice"|"score", "instructions": "...", "criteria": ...}}}
 *   -> {"model": "jev-1.13.0",
 *       "answers": {"<key>": {"type": "noul", "noul": 0.92} | {"type": "choice", ...} | ...},
 *       "usage": {"input_tokens": N, "output_tokens": 0}}
 * Error codes: 401 (key), 422 (validation), 429 (rate limit), 529 (overload).
 *
 * Pricing (vendor list, 2026-09): $0.042 per 1M input tokens, output free.
 * Latency (vendor claim): 70-500ms end to end. Limits: ~32k tokens for state
 * plus the longest single question, ~64k for state plus all questions.
 *
 * Env: JEV_API_KEY (preferred) or TYPESAFE_API_KEY (vendor's own name).
 * Optional override: JEV_BASE_URL (defaults to https://api.typesafe.ai).
 *
 * Called By:
 * - AIRouter provider-creation switch (name contains "jev" or "typesafe")
 * - Future: a dedicated triage consumer via evaluate() — NOT chat routing
 *
 * Never:
 * - Call chat()/stream() expecting text — they throw by design
 * - Trust an answer that fails shape validation — evaluate() throws instead
 * ==========================================================
 */

import { BaseAIProvider } from './AIProvider';

/** Jev's evaluation endpoint. Overridable via JEV_BASE_URL for self-hosted/
 *  community-compatible gateways (e.g. OpenJev); the path /v1/systemone is
 *  appended by this provider. */
function resolveJevBaseUrl(): string {
  const fromEnv = (process.env.JEV_BASE_URL || '').trim().replace(/\/+$/, '');
  return fromEnv || 'https://api.typesafe.ai';
}

/** Alias that currently resolves to jev-1.13.0. Pin a versioned id (e.g.
 *  "jev-1.13.0") in production consumers — aliases can move. */
export const JEV_DEFAULT_MODEL = 'jev-latest';
/** Vendor list price, 2026-09. Verify against TypeSafe's current pricing
 *  before relying on this for budget decisions. */
export const JEV_INPUT_USD_PER_MILLION_TOKENS = 0.042;

export interface JevNoulQuestion { type: 'noul'; instructions: string; }
export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** option label -> description; up to 255 options per vendor docs */
  criteria: Record<string, string>;
}
export interface JevScoreQuestion {
  type: 'score';
  instructions: string;
  /** ordered level descriptions, 2-10 entries per vendor docs */
  criteria: string[];
}
export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

export interface JevNoulAnswer { type: 'noul'; noul: number; }
export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface JevScoreAnswer {
  type: 'score';
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}
export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevEvaluationResult {
  /** The model that actually answered (e.g. "jev-1.13.0") — log this, not the alias. */
  model: string;
  answers: Record<string, JevAnswer>;
  inputTokens: number;
  /** Always 0 — Jev generates no text tokens. */
  outputTokens: number;
}

export class JevAnswerValidationError extends Error {
  constructor(message: string) {
    super(`[Jev] answer validation failed (fail-closed): ${message}`);
    this.name = 'JevAnswerValidationError';
  }
}

/**
 * Typed HTTP error for non-2xx responses from the System One endpoint.
 * Replaces the generic Error('[Jev] API error: ...') so consumers can
 * classify failures (auth vs. rate limit vs. server) without parsing
 * message text. The key is never included in the message.
 */
export class JevHttpError extends Error {
  readonly statusCode: number;
  /** Coarse bucket for routing decisions; JevDecisionProvider refines by status code. */
  readonly kind: 'AUTH' | 'RATE_LIMIT' | 'OVERLOAD' | 'SERVER';

  constructor(statusCode: number, statusText: string, bodySnippet?: string) {
    const snippet = (bodySnippet || '').trim();
    super(`[Jev] API error: ${statusCode}${statusText ? ` ${statusText}` : ''}${snippet ? ` - ${snippet}` : ''}`);
    this.name = 'JevHttpError';
    this.statusCode = statusCode;
    this.kind =
      statusCode === 401 ? 'AUTH'
      : statusCode === 429 ? 'RATE_LIMIT'
      : statusCode === 529 ? 'OVERLOAD'
      : 'SERVER';
  }
}

function isFiniteProbability(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

export class JevProvider extends BaseAIProvider {
  private apiKey: string = '';
  private defaultModel: string = JEV_DEFAULT_MODEL;
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    super();
    this.providerName = 'Jev';
    this.baseUrl = (baseUrl || resolveJevBaseUrl()).replace(/\/+$/, '');
  }

  async initialize(apiKey?: string, defaultModel?: string): Promise<void> {
    this.apiKey = (apiKey || '').trim();
    this.defaultModel = (defaultModel || '').trim() || JEV_DEFAULT_MODEL;
  }

  async authenticate(): Promise<boolean> {
    return !!this.apiKey;
  }

  /**
   * Evaluate a state against typed questions. Every requested question key MUST
   * come back with a well-formed, type-matching answer — anything else throws
   * JevAnswerValidationError. Never synthesizes a probability.
   */
  async evaluate(
    state: string | Record<string, unknown> | unknown[],
    questions: Record<string, JevQuestion>,
    options?: { model?: string; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<JevEvaluationResult> {
    if (!this.apiKey) throw new Error('[Jev] not authenticated — set JEV_API_KEY');
    const questionKeys = Object.keys(questions);
    if (questionKeys.length === 0) throw new Error('[Jev] evaluate() requires at least one question');

    const model = (options?.model || '').trim() || this.defaultModel;
    const body = JSON.stringify({ model, state, questions });

    const data = await this.postSystemOne(body, options);
    const answers = (data as any)?.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      throw new JevAnswerValidationError('response has no answers object');
    }
    for (const key of questionKeys) {
      this.validateAnswer(key, questions[key], (answers as Record<string, unknown>)[key]);
    }
    const usage = (data as any)?.usage || {};
    return {
      model: typeof (data as any)?.model === 'string' ? (data as any).model : model,
      answers: answers as Record<string, JevAnswer>,
      inputTokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0,
      outputTokens: 0, // Jev generates no text tokens, by vendor design
    };
  }

  /** Convenience: single yes/no question. Returns P(yes) in [0,1]. */
  async askYesNo(
    state: string | Record<string, unknown> | unknown[],
    instructions: string,
    options?: { model?: string; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ probabilityYes: number; model: string; inputTokens: number }> {
    const result = await this.evaluate(state, { q: { type: 'noul', instructions } }, options);
    const answer = result.answers.q as JevNoulAnswer;
    return { probabilityYes: answer.noul, model: result.model, inputTokens: result.inputTokens };
  }

  private validateAnswer(key: string, question: JevQuestion, answer: unknown): void {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
      throw new JevAnswerValidationError(`missing answer for question "${key}"`);
    }
    const a = answer as Record<string, unknown>;
    if (a.type !== question.type) {
      throw new JevAnswerValidationError(
        `question "${key}" asked type "${question.type}" but answer type was ${JSON.stringify(a.type)}`,
      );
    }
    if (question.type === 'noul') {
      if (!isFiniteProbability(a.noul)) {
        throw new JevAnswerValidationError(`question "${key}" noul answer is not a finite probability: ${JSON.stringify(a.noul)}`);
      }
      return;
    }
    if (!isFiniteProbability(a.confidence)) {
      throw new JevAnswerValidationError(`question "${key}" confidence is not a finite probability: ${JSON.stringify(a.confidence)}`);
    }
    const probs = a.probabilities;
    if (!probs || typeof probs !== 'object' || Array.isArray(probs)) {
      throw new JevAnswerValidationError(`question "${key}" has no probabilities object`);
    }
    for (const [label, p] of Object.entries(probs)) {
      if (!isFiniteProbability(p)) {
        throw new JevAnswerValidationError(`question "${key}" probability for "${label}" is not finite in [0,1]: ${JSON.stringify(p)}`);
      }
    }
    if (question.type === 'choice') {
      const choice = a.choice;
      if (typeof choice !== 'string' || !(choice in question.criteria)) {
        throw new JevAnswerValidationError(
          `question "${key}" choice ${JSON.stringify(choice)} is not one of the declared criteria options`,
        );
      }
      return;
    }
    // score
    if (typeof a.score !== 'number' || !Number.isFinite(a.score)) {
      throw new JevAnswerValidationError(`question "${key}" score is not finite: ${JSON.stringify(a.score)}`);
    }
  }

  private async postSystemOne(body: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      // One community client reports the API firewall 403s requests with a
      // missing/generic user agent — send an identifying one.
      'User-Agent': 'Argus-Trading-Terminal/jev-research-spike',
    };

    let retries = 0;
    const maxRetries = 2;
    let delayMs = 500;
    // Per-attempt timeout so a hung call can't stall a trading cycle
    // indefinitely; default 15s, well above the vendor's 70-500ms claim.
    const timeoutMs = options?.timeoutMs ?? 15000;

    while (retries <= maxRetries) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onExternalAbort = options?.signal ? () => controller.abort() : undefined;
      if (options?.signal && onExternalAbort) {
        if (options.signal.aborted) controller.abort();
        else options.signal.addEventListener('abort', onExternalAbort);
      }
      try {
        const response = await fetch(`${this.baseUrl}/v1/systemone`, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });
        if (!response.ok) {
          // 429 rate limit / 529 vendor overload / 5xx: retry with backoff.
          // 401 bad key / 422 our request was malformed: never retry.
          if ((response.status === 429 || response.status === 529 || response.status >= 500) && retries < maxRetries) {
            retries++;
            await new Promise((r) => setTimeout(r, delayMs));
            delayMs *= 2;
            continue;
          }
          let snippet = '';
          try { snippet = (await response.text()).slice(0, 300); } catch { /* fall through */ }
          throw new JevHttpError(response.status, response.statusText, snippet);
        }
        return await response.json();
      } catch (err: any) {
        const isAbort = err?.name === 'AbortError';
        const isNetwork = /fetch|network|ECONN|ENOTFOUND|ETIMEDOUT/i.test(err?.message || '');
        if (!isAbort && isNetwork && retries < maxRetries) {
          retries++;
          await new Promise((r) => setTimeout(r, delayMs));
          delayMs *= 2;
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
        if (options?.signal && onExternalAbort) options.signal.removeEventListener('abort', onExternalAbort);
      }
    }
    throw new Error('[Jev] failed after retries');
  }

  // --- AIProvider chat-centric surface: Jev generates no text, by design. ---
  // These fail closed with a clear error rather than pretending to work, so a
  // misconfigured route surfaces immediately instead of producing empty/garbage
  // "completions" downstream.

  private static readonly NO_TEXT = '[Jev] does not generate text — it is a decision model. Use evaluate()/askYesNo() for typed probabilistic answers.';

  async chat(_prompt: string, _options?: any): Promise<{ content: string; tokens: number; inputTokens?: number; outputTokens?: number }> {
    throw new Error(JevProvider.NO_TEXT);
  }

  async *stream(_prompt: string, _options?: any): AsyncGenerator<string, void, unknown> {
    throw new Error(JevProvider.NO_TEXT);
  }

  async embeddings(_text: string): Promise<number[]> {
    throw new Error(JevProvider.NO_TEXT);
  }

  async vision(_image: Buffer, _prompt: string): Promise<{ content: string; tokens: number }> {
    throw new Error(JevProvider.NO_TEXT);
  }

  async image(_prompt: string): Promise<Buffer> {
    throw new Error(JevProvider.NO_TEXT);
  }

  async health(): Promise<string> {
    // No documented health endpoint; a probe evaluation would spend real input
    // tokens, so health is credential-presence only. AIRouter's normal
    // failover path handles runtime failures via evaluate() errors.
    return this.apiKey ? 'Healthy' : 'Missing API key';
  }

  estimateCost(inputTokens: number, _outputTokens: number): number {
    // Output tokens are always 0 for Jev (no text generation) — ignored here
    // rather than billed.
    return (inputTokens / 1_000_000) * JEV_INPUT_USD_PER_MILLION_TOKENS;
  }

  estimateLatency(): number {
    // Vendor-claimed 70-500ms end-to-end; midpoint as a planning figure, NOT a
    // measured value. Measure before using this in any routing budget.
    return 300;
  }

  supportsTools(): boolean { return false; }
  supportsReasoning(): boolean { return false; }
  supportsVision(): boolean { return false; }
  /** False in the chat-JSON-mode sense this flag means across AIRouter.
   *  Jev's native typed answers are structured by design — exposed via
   *  evaluate(), not via chat(). */
  supportsStructuredOutput(): boolean { return false; }
  supportsStreaming(): boolean { return false; }
}
