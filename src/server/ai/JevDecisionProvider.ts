/**
 * ==========================================================
 * Module:
 * JevDecisionProvider.ts
 *
 * Purpose:
 * Dedicated STRUCTURED-DECISION provider for TypeSafe AI's Jev ("System One").
 * Jev is NOT a chat LLM: it takes a `state` plus a map of typed questions and
 * returns typed probabilistic answers (choice / score / noul) — zero text
 * tokens. This provider sits BESIDE the generative AIRouter under the
 * AICallGovernor and is used only for event-driven, optional enrichment.
 *
 * QUANT-FIRST contract: Jev failure is always NEUTRAL for validated quant.
 * A Jev failure surfaces as a typed JevError and must never block, alter, or
 * gate a validated quant strategy's decision path — the caller treats any
 * JevError as "no enrichment available" and proceeds with quant evidence
 * alone.
 *
 * Auth: JEV_API_KEY (preferred) or TYPESAFE_API_KEY, read from process.env at
 * call time. The key is mapped to the Bearer header server-side and is NEVER
 * logged, printed, persisted, or interpolated into an error message. Unit
 * tests use mocked fetch only — never real network.
 *
 * Called By:
 * - Future: AICallGovernor event-driven enrichment (not wired yet)
 *
 * Never:
 * - Import BrokerManager/OrderManagement/RiskEngine/ChiefTraderAgent
 * - Emit CHIEF_APPROVED_IDEA or any trading event
 * - Call decide() with an expectation that it always succeeds — enrichment
 *   is optional by design
 * ==========================================================
 */

import { JevProvider, JevAnswerValidationError, JevHttpError } from './providers/JevProvider';
import type { JevQuestion, JevAnswer } from './providers/JevProvider';

/** Re-exported so consumers type questions/answers without reaching into providers/. */
export type { JevQuestion, JevAnswer } from './providers/JevProvider';

export type JevErrorKind =
  | 'NO_API_KEY'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'OVERLOAD'
  | 'SERVER'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'VALIDATION'
  | 'ABORTED'
  | 'UNKNOWN';

const DEFAULT_RETRYABLE: Record<JevErrorKind, boolean> = {
  NO_API_KEY: false,
  AUTH: false,
  RATE_LIMIT: true,
  OVERLOAD: true,
  SERVER: true,
  NETWORK: true,
  TIMEOUT: true,
  VALIDATION: false,
  ABORTED: false,
  UNKNOWN: false,
};

/**
 * Typed failure for a structured-decision call. Carries the failure kind, the
 * HTTP status when one exists, and whether retrying could plausibly help.
 * Messages never contain the API key.
 */
export class JevError extends Error {
  readonly kind: JevErrorKind;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(kind: JevErrorKind, message: string, opts?: { status?: number; retryable?: boolean }) {
    super(`[Jev] ${message}`);
    this.name = 'JevError';
    this.kind = kind;
    this.status = opts?.status;
    this.retryable = opts?.retryable ?? DEFAULT_RETRYABLE[kind];
  }
}

export interface JevDecisionRequest {
  state: unknown;
  questions: Record<string, JevQuestion>;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Reserved for future wire revisions; carried, not sent (the vendor wire format is fixed). */
  schemaVersion: string;
}

export interface JevDecisionResult {
  answers: Record<string, JevAnswer>;
  model: string;
  inputTokens: number;
  latencyMs: number;
}

/** Env convention (deployment .env only; never committed): JEV_API_KEY preferred, TYPESAFE_API_KEY fallback. */
function resolveApiKey(): string {
  return (process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY || '').trim();
}

function resolveBaseUrl(): string {
  const fromEnv = (process.env.JEV_BASE_URL || '').trim().replace(/\/+$/, '');
  return fromEnv || 'https://api.typesafe.ai';
}

/** Unique race sentinel so our own timeout is never confused with a provider AbortError. */
const TIMEOUT_SENTINEL = Symbol('jev-decision-timeout');

/** Defense-in-depth: strip any occurrence of the API key from a message before
 *  it can reach an Error, a log line, or an operator surface. The key should
 *  never be in these strings in the first place (we never interpolate it), but
 *  a server echoing request material back in an error body must not leak it. */
function redactKey(message: string, apiKey: string): string {
  if (!apiKey) return message;
  return message.split(apiKey).join('[REDACTED]');
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError';
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'TypeError' && /fetch failed|network|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(err.message);
}

/** Best-effort extraction of model names from the undocumented /v1/models shape. */
function extractModelNames(data: unknown): string[] | null {
  const pick = (arr: unknown[]): string[] => {
    const names: string[] = [];
    for (const item of arr) {
      if (typeof item === 'string') {
        names.push(item);
      } else if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        const id = o.id ?? o.model ?? o.name;
        if (typeof id === 'string') names.push(id);
      }
    }
    return names;
  };
  if (Array.isArray(data)) return pick(data);
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.models)) return pick(o.models);
    if (Array.isArray(o.data)) return pick(o.data);
  }
  return null;
}

export class JevDecisionProvider {
  private static instance: JevDecisionProvider | null = null;

  static getInstance(): JevDecisionProvider {
    if (!JevDecisionProvider.instance) {
      JevDecisionProvider.instance = new JevDecisionProvider();
    }
    return JevDecisionProvider.instance;
  }

  /** Structured probabilistic answers — not generative text. */
  readonly capability = 'STRUCTURED_DECISION' as const;

  /** True iff a non-empty key is present in env. Never logs the key. */
  isConfigured(): boolean {
    return resolveApiKey().length > 0;
  }

  /** Test seam: drop the singleton so env changes between tests take effect. */
  resetForTests(): void {
    JevDecisionProvider.instance = null;
  }

  /**
   * Run one structured-decision request (multiple questions, one HTTP call).
   * Throws JevError on any failure. Measures wall-clock latencyMs around the
   * provider call. With no API key configured, throws JevError('NO_API_KEY')
   * before any network attempt.
   */
  async decide(req: JevDecisionRequest): Promise<JevDecisionResult> {
    const key = resolveApiKey();
    if (!key) {
      throw new JevError(
        'NO_API_KEY',
        'Jev is not configured — set JEV_API_KEY (or TYPESAFE_API_KEY) in the deployment .env',
        { retryable: false },
      );
    }
    const questionKeys = req.questions ? Object.keys(req.questions) : [];
    if (questionKeys.length === 0) {
      throw new JevError('VALIDATION', 'decide() requires at least one question', { retryable: false });
    }

    const provider = new JevProvider();
    await provider.initialize(key, req.model);

    const started = Date.now();

    // JevDecisionProvider owns the timeout: our timer firing => TIMEOUT, an
    // external AbortSignal (or the provider's own default when no timeoutMs was
    // given) => ABORTED. The sentinel wins the race deterministically because
    // it is rejected synchronously in our timer callback before the abort
    // propagates to the fetch promise.
    const controller = new AbortController();
    let timedOutByUs = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      if (req.timeoutMs !== undefined && Number.isFinite(req.timeoutMs) && req.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOutByUs = true;
          try { controller.abort(); } catch { /* noop */ }
          reject(TIMEOUT_SENTINEL);
        }, req.timeoutMs);
        if (typeof (timer as unknown as { unref?: unknown }).unref === 'function') {
          (timer as unknown as { unref: () => void }).unref();
        }
      }
    });
    const onExternalAbort = () => { try { controller.abort(); } catch { /* noop */ } };
    if (req.signal) {
      if (req.signal.aborted) onExternalAbort();
      else req.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const result = await Promise.race([
        provider.evaluate(
          req.state as string | Record<string, unknown> | unknown[],
          req.questions,
          { model: req.model, signal: controller.signal, timeoutMs: req.timeoutMs },
        ),
        timeoutPromise,
      ]);
      return {
        answers: result.answers,
        model: result.model,
        inputTokens: result.inputTokens,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      if (err === TIMEOUT_SENTINEL) {
        throw new JevError('TIMEOUT', `Jev request timed out after ${req.timeoutMs}ms`, { retryable: true });
      }
      throw JevDecisionProvider.classifyError(err, timedOutByUs, key);
    } finally {
      if (timer) clearTimeout(timer);
      if (req.signal) req.signal.removeEventListener('abort', onExternalAbort);
    }
  }

  /**
   * Smoke-test helper only: GET {base}/v1/models. Never called by decide().
   * Requires a configured key; throws JevError like decide() on failure.
   */
  async discoverModels(signal?: AbortSignal): Promise<string[]> {
    const key = resolveApiKey();
    if (!key) {
      throw new JevError(
        'NO_API_KEY',
        'Jev is not configured — set JEV_API_KEY (or TYPESAFE_API_KEY) in the deployment .env',
        { retryable: false },
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const onExternalAbort = () => { try { controller.abort(); } catch { /* noop */ } };
    if (signal) {
      if (signal.aborted) onExternalAbort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    try {
      const response = await fetch(`${resolveBaseUrl()}/v1/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
          'User-Agent': 'Argus-Trading-Terminal/jev-decision-provider',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        let snippet = '';
        try { snippet = (await response.text()).slice(0, 300); } catch { /* noop */ }
        throw JevDecisionProvider.classifyError(new JevHttpError(response.status, response.statusText, snippet), false, key);
      }
      const data: unknown = await response.json();
      const models = extractModelNames(data);
      if (!models) {
        throw new JevError('VALIDATION', 'Jev /v1/models returned an unrecognized shape', { retryable: false });
      }
      return models;
    } catch (err) {
      if (err instanceof JevError) throw err;
      if (isAbortError(err)) {
        const aborted = !!signal?.aborted;
        throw new JevError(
          aborted ? 'ABORTED' : 'TIMEOUT',
          aborted ? 'Jev model discovery aborted' : 'Jev model discovery timed out',
          { retryable: !aborted },
        );
      }
      if (err instanceof SyntaxError) {
        throw new JevError('VALIDATION', 'Jev /v1/models returned malformed JSON', { retryable: false });
      }
      if (isNetworkError(err)) {
        throw new JevError('NETWORK', 'Jev network failure during model discovery', { retryable: true });
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new JevError(
        'UNKNOWN',
        message ? `Jev model discovery failed: ${message}` : 'Jev model discovery failed',
        { retryable: false },
      );
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }
  }

  private static classifyError(err: unknown, timedOutByUs: boolean, apiKey: string): JevError {
    const fail = (kind: JevErrorKind, message: string, opts?: { status?: number; retryable?: boolean }): JevError =>
      new JevError(kind, redactKey(message, apiKey), opts);
    if (err instanceof JevError) return err;
    if (err instanceof JevHttpError) {
      const status = err.statusCode;
      if (status === 401) return fail('AUTH', 'Jev authentication failed (401) — check the API key', { status });
      if (status === 429) return fail('RATE_LIMIT', 'Jev rate limit hit (429)', { status });
      if (status === 529) return fail('OVERLOAD', 'Jev overloaded (529)', { status });
      if (status === 422) return fail('VALIDATION', 'Jev rejected the request as malformed (422)', { status });
      if (status >= 500) return fail('SERVER', `Jev server error (${status})`, { status });
      return fail('UNKNOWN', `Jev request failed with HTTP ${status}`, { status });
    }
    if (err instanceof JevAnswerValidationError) {
      // Fail-closed answer validation stays fail-closed; never retryable —
      // retrying the same request shape would not fix it.
      return fail('VALIDATION', err.message.replace(/^\[Jev\] /, ''), { retryable: false });
    }
    if (isAbortError(err)) {
      return timedOutByUs
        ? fail('TIMEOUT', 'Jev request timed out', { retryable: true })
        : fail('ABORTED', 'Jev request aborted', { retryable: false });
    }
    if (err instanceof SyntaxError) {
      return fail('VALIDATION', 'Jev returned malformed JSON', { retryable: false });
    }
    if (isNetworkError(err)) {
      return fail('NETWORK', 'Jev network failure', { retryable: true });
    }
    const message = err instanceof Error ? err.message : String(err);
    return fail(
      'UNKNOWN',
      message ? `Jev request failed: ${message}` : 'Jev request failed',
      { retryable: false },
    );
  }
}
