/**
 * ==========================================================
 * Module: AICallGovernor.ts
 *
 * Purpose:
 * Central gate for ALL optional AI calls in Argus. Argus is QUANT-FIRST:
 * validated quant must trade with zero AI. The default state is NO AI CALL -
 * ticks, quotes, scans, strategy evaluations and consensus cycles NEVER call
 * AI directly. Only material events (new catalyst, regime change, high-quality
 * quant candidate, genuine conflict, premarket final set, post-trade research)
 * may be *considered*, and then only through this governor.
 *
 * Architecture: AICallGovernor -> JevDecisionProvider (STRUCTURED_DECISION)
 * or an injected generative executor (GENERATIVE_ANALYSIS). Jev failure is
 * NEUTRAL for quant; AI-originated ideas fail closed.
 *
 * HARD RULE - NO AUTOMATIC FAILOVER, EVER: a failed STRUCTURED_DECISION (Jev)
 * call is NEVER retried as GENERATIVE_ANALYSIS, and a failed GENERATIVE_ANALYSIS
 * is NEVER retried as STRUCTURED_DECISION. A Jev outage must not become a
 * cost storm of expensive LLM calls. Each capability fails independently and
 * closed; callers decide what to do with a FAILED/SKIPPED result.
 *
 * Check order (first hit wins, each emitting its observability event):
 *   DISABLED -> STALE_EVENT -> DEADLINE_TOO_CLOSE -> NOT_MATERIAL ->
 *   CACHE_HIT -> DUPLICATE (singleflight join) -> SYMBOL_COOLDOWN ->
 *   GLOBAL_BUDGET -> PROVIDER_BUDGET -> PROVIDER_UNHEALTHY (NO_API_KEY for Jev)
 *   -> CIRCUIT_OPEN -> QUEUE_FULL -> SHOULD_CALL
 *
 * Secrets: JEV_API_KEY is deployment-only. Request state bodies (which may
 * contain key material or sensitive content) are NEVER logged - only
 * kind/symbol/fingerprint-hash/latency flow into observability events.
 *
 * Called By:
 * - (future) material-event producers: news catalyst triage, regime-change
 *   detection, quant candidate advisory, premarket enrichment, post-trade research.
 *
 * Never:
 * - Called from a tick/quote/scan/strategy-evaluation/consensus hot path.
 * - Used to manufacture trading activity ("healthy and capable", never forced).
 * - Imported by BrokerManager / OrderManagement / RiskEngine / ChiefTraderAgent.
 * ==========================================================
 */

import { createHash } from 'crypto';
import {
  JevDecisionProvider,
  type JevDecisionRequest,
  type JevDecisionResult,
  type JevQuestion,
} from './JevDecisionProvider';
import {
  aiCallGovernor,
  isAiCallGovernorEnabled,
  isJevCapabilityEnabled,
} from '../config/aiCallGovernor';
import { structuredLogger, observeSafe } from '../observability/StructuredLogger';

// Re-exported so governor-mediated callers (e.g. JevNewsTriage) can name the decision type
// without importing JevDecisionProvider directly.
export type { JevDecisionRequest, JevDecisionResult };

// ---------------------------------------------------------------------------
// Public contract (other workers code against exactly this surface)
// ---------------------------------------------------------------------------

export type AiCapability = 'STRUCTURED_DECISION' | 'GENERATIVE_ANALYSIS';

export type GovernorSkipReason =
  | 'DISABLED'
  | 'NOT_MATERIAL'
  | 'CACHE_HIT'
  | 'DUPLICATE'
  | 'SYMBOL_COOLDOWN'
  | 'GLOBAL_BUDGET'
  | 'PROVIDER_BUDGET'
  | 'PROVIDER_UNHEALTHY'
  | 'DEADLINE_TOO_CLOSE'
  | 'NO_API_KEY'
  | 'STALE_EVENT'
  | 'QUEUE_FULL'
  | 'CIRCUIT_OPEN';

export interface AiCallMaterial {
  symbol?: string;
  fingerprintParts: Record<string, string | number | boolean | null | undefined>;
  materiality: 'HIGH' | 'MEDIUM' | 'LOW';
  /** Epoch ms by which the decision is needed; past it the event is STALE. */
  decisionDeadlineMs: number;
  traceId?: string;
}

export type GovernorResult<T> =
  | { status: 'CALLED'; result: T; latencyMs: number }
  | { status: 'CACHE_HIT'; result: T }
  | { status: 'SKIPPED'; reason: GovernorSkipReason; detail: string }
  | { status: 'FAILED'; error: unknown; kind: string };

export interface JevCallSpec {
  state: unknown;
  questions: Record<string, unknown>;
  model?: string;
  schemaVersion: string;
}

export interface GovernorRequestOpts<T> {
  capability: AiCapability;
  kind: string;
  material: AiCallMaterial;
  ttlMs?: number;
  /** Not used for STRUCTURED_DECISION (the governor builds the Jev request itself). */
  run: (ctx: { signal: AbortSignal; timeoutMs: number }) => Promise<{ value: T; cacheable: boolean }>;
  /** Required for STRUCTURED_DECISION; ignored for GENERATIVE_ANALYSIS. */
  jev?: JevCallSpec;
}

export type GenerativeExecutor = (ctx: {
  signal: AbortSignal;
  timeoutMs: number;
}) => Promise<{ value: unknown; cacheable: boolean }>;

// ---------------------------------------------------------------------------
// Sibling-owned JevDecisionProvider (src/server/ai/JevDecisionProvider.ts)
// ---------------------------------------------------------------------------

/**
 * Structural handle over the sibling-owned JevDecisionProvider: the governor
 * only needs isConfigured()/decide(), and tests inject fakes through
 * __setJevProviderForTests(). The real singleton satisfies this structurally.
 */
export interface JevProviderHandle {
  isConfigured(): boolean;
  decide(req: JevDecisionRequest): Promise<JevDecisionResult>;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type ProviderKey = 'jev' | 'generative';
type CircuitStateName = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitState {
  state: CircuitStateName;
  consecutiveFailures: number;
  openedAt: number;
  halfOpenProbesUsed: number;
}

interface CacheEntry {
  value: unknown;
  storedAt: number;
  ttlMs: number;
}

/** Failure kinds that count toward tripping the circuit breaker (provider-health signals). */
const CIRCUIT_TRIPPING_KINDS = new Set([
  'TIMEOUT',
  'RATE_LIMIT',
  'OVERLOAD',
  'SERVER',
  'NETWORK',
  'UNKNOWN',
]);
/**
 * Failure kinds that do NOT trip the breaker: a 401 means a bad key, not a sick
 * provider. These mark the provider unhealthy instead (subsequent requests skip
 * at the PROVIDER_UNHEALTHY step) until a success or resetForTests() clears it.
 */
const NON_TRIpping_KINDS = new Set(['AUTH', 'VALIDATION', 'NO_API_KEY']);

type Materiality = 'HIGH' | 'MEDIUM' | 'LOW';
const MATERIALITY_RANK: Record<Materiality, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/**
 * Per-kind minimum materiality, from config-adjacent policy (see
 * config/aiCallGovernor.json cacheTtlMsByKind for the governed kind set).
 * LOW materiality passes ONLY for kinds explicitly allowed here
 * (post_trade_research); everything else needs at least MEDIUM, regime_change
 * needs HIGH. Unknown kinds default to MEDIUM - fail closed on ambiguity.
 */
const MIN_MATERIALITY_BY_KIND: Record<string, Materiality> = {
  news_catalyst_triage: 'MEDIUM',
  jev_news_shadow_scoring: 'LOW',
  regime_change: 'HIGH',
  quant_candidate_advisory: 'MEDIUM',
  premarket_enrichment: 'MEDIUM',
  post_trade_research: 'LOW',
};
const DEFAULT_MIN_MATERIALITY: Materiality = 'MEDIUM';

/** Default cache TTL when the kind has no entry in cacheTtlMsByKind (5 min). */
const DEFAULT_CACHE_TTL_MS = 300000;
/** Cap on tracked latencies for percentile math. */
const MAX_LATENCY_SAMPLES = 1024;
/** Cap on per-symbol budget buckets (bounded count; oldest pruned). */
const MAX_SYMBOL_BUCKETS = 2000;
/** Generative calls share the Jev call timeout until dedicated generative tuning is configured. */
function defaultCallTimeoutMs(): number {
  return aiCallGovernor.jevTimeoutMs;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

function fingerprintHash(fingerprint: string): string {
  return createHash('sha256').update(fingerprint).digest('hex').slice(0, 16);
}

/** Sliding-window counter (per-minute token bucket). Timestamps in ms. */
class SlidingWindow {
  private hits: number[] = [];
  constructor(private readonly windowMs: number = 60000) {}
  private prune(now: number): void {
    const cut = now - this.windowMs;
    let i = 0;
    while (i < this.hits.length && this.hits[i] <= cut) i++;
    if (i > 0) this.hits.splice(0, i);
  }
  peekExceeded(now: number, limit: number): boolean {
    this.prune(now);
    return this.hits.length >= limit;
  }
  tryAcquire(now: number, limit: number): boolean {
    this.prune(now);
    if (this.hits.length >= limit) return false;
    this.hits.push(now);
    return true;
  }
  reset(): void {
    this.hits = [];
  }
}

function classifyFailureKind(err: unknown): string {
  const kind = (err as { kind?: unknown } | null)?.kind;
  if (typeof kind === 'string' && kind.length > 0) return kind;
  if (err instanceof Error && /abort/i.test(err.name)) return 'TIMEOUT';
  return 'UNKNOWN';
}

function timeoutError(timeoutMs: number): Error {
  const err = new Error(`AI call timed out after ${timeoutMs}ms`);
  (err as unknown as { kind: string }).kind = 'TIMEOUT';
  (err as unknown as { code: string }).code = 'AI_CALL_TIMEOUT';
  return err;
}

// ---------------------------------------------------------------------------
// AICallGovernor
// ---------------------------------------------------------------------------

export class AICallGovernor {
  private static instance: AICallGovernor | null = null;
  static getInstance(): AICallGovernor {
    if (!AICallGovernor.instance) AICallGovernor.instance = new AICallGovernor();
    return AICallGovernor.instance;
  }

  private nowFn: () => number = () => Date.now();
  private generativeExecutor: GenerativeExecutor | null = null;

  private jevProviderOverride: JevProviderHandle | null | undefined = undefined;

  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<GovernorResult<unknown>>>();
  private readonly inFlightCount: Record<ProviderKey, number> = { jev: 0, generative: 0 };
  private readonly circuits: Record<ProviderKey, CircuitState> = {
    jev: { state: 'CLOSED', consecutiveFailures: 0, openedAt: 0, halfOpenProbesUsed: 0 },
    generative: { state: 'CLOSED', consecutiveFailures: 0, openedAt: 0, halfOpenProbesUsed: 0 },
  };
  private readonly providerUnhealthy: Record<ProviderKey, boolean> = { jev: false, generative: false };

  private readonly globalWindow = new SlidingWindow();
  private readonly providerWindows: Record<ProviderKey, SlidingWindow> = {
    jev: new SlidingWindow(),
    generative: new SlidingWindow(),
  };
  private readonly symbolWindows = new Map<string, SlidingWindow>();
  private readonly symbolCooldownAt = new Map<string, number>();

  private readonly diag = {
    considered: 0,
    called: 0,
    cacheHits: 0,
    singleflightJoins: 0,
    skips: {} as Record<string, number>,
    failures: 0,
    timeouts: 0,
    latencies: [] as number[],
  };

  // -- internal helpers -----------------------------------------------------

  private now(): number {
    return this.nowFn();
  }

  private emit(
    eventType: string,
    fields: {
      kind?: string;
      symbol?: string;
      traceId?: string;
      reason?: string;
      detail?: string;
      latencyMs?: number;
      fingerprintHash?: string;
      provider?: string;
      extra?: Record<string, unknown>;
    } = {},
  ): void {
    // NEVER log request state bodies / questions / keys - only
    // kind/symbol/fingerprint-hash/latency/reason flow into observability.
    observeSafe(() => {
      structuredLogger.info(`[AICallGovernor] ${eventType}`, {
        component: 'AICallGovernor',
        category: 'AI_GOVERNOR',
        eventType,
        kind: fields.kind,
        symbol: fields.symbol,
        traceId: fields.traceId,
        reason: fields.reason,
        detail: fields.detail,
        latencyMs: fields.latencyMs,
        fingerprintHash: fields.fingerprintHash,
        provider: fields.provider,
        ...(fields.extra ?? {}),
      });
    }, 'AICallGovernor');
  }

  private skip(
    reason: GovernorSkipReason,
    detail: string,
    ctx: { kind: string; symbol?: string; traceId?: string; fingerprintHash: string },
  ): GovernorResult<never> {
    this.diag.skips[reason] = (this.diag.skips[reason] ?? 0) + 1;
    this.emit('AI_CALL_SKIPPED', {
      kind: ctx.kind,
      symbol: ctx.symbol,
      traceId: ctx.traceId,
      reason,
      detail,
      fingerprintHash: ctx.fingerprintHash,
    });
    return { status: 'SKIPPED', reason, detail };
  }

  private computeFingerprint(
    capability: AiCapability,
    kind: string,
    model: string | null,
    schemaVersion: string | null,
    symbol: string | undefined,
    parts: Record<string, string | number | boolean | null | undefined>,
  ): string {
    // NEVER include wall-clock, traceId, or volatile fields: identical
    // material content must produce an identical fingerprint (cache +
    // singleflight correctness).
    return stableStringify({
      capability,
      kind,
      model: model ?? null,
      schemaVersion: schemaVersion ?? null,
      symbol: symbol ?? null,
      parts,
    });
  }

  private getJevProvider(): JevProviderHandle | null {
    if (this.jevProviderOverride !== undefined) return this.jevProviderOverride;
    return JevDecisionProvider.getInstance();
  }

  private symbolWindow(symbol: string): SlidingWindow {
    let w = this.symbolWindows.get(symbol);
    if (!w) {
      if (this.symbolWindows.size >= MAX_SYMBOL_BUCKETS) {
        const oldest = this.symbolWindows.keys().next();
        if (!oldest.done) this.symbolWindows.delete(oldest.value);
      }
      w = new SlidingWindow();
      this.symbolWindows.set(symbol, w);
    }
    return w;
  }

  private pruneSymbolCooldowns(now: number): void {
    const ttl = aiCallGovernor.aiPerSymbolCooldownMs;
    for (const [sym, at] of this.symbolCooldownAt) {
      if (now - at >= ttl) this.symbolCooldownAt.delete(sym);
    }
    if (this.symbolCooldownAt.size > MAX_SYMBOL_BUCKETS) {
      const oldest = this.symbolCooldownAt.keys().next();
      if (!oldest.done) this.symbolCooldownAt.delete(oldest.value);
    }
  }

  // -- public API ------------------------------------------------------------

  setGenerativeExecutor(fn: GenerativeExecutor): void {
    this.generativeExecutor = fn;
  }

  async request<T>(opts: GovernorRequestOpts<T>): Promise<GovernorResult<T>> {
    const cfg = aiCallGovernor;
    const now = this.now();
    const { capability, kind, material } = opts;
    const providerKey: ProviderKey = capability === 'STRUCTURED_DECISION' ? 'jev' : 'generative';
    const symbol = material.symbol;
    const traceId = material.traceId;

    // Resolve the Jev provider handle up front (synchronous) so the later
    // PROVIDER_UNHEALTHY step stays synchronous and singleflight registration
    // below stays race-free. Resolving the handle emits nothing and changes
    // no check - isConfigured() is still evaluated at its mandated position.
    const jevProvider =
      capability === 'STRUCTURED_DECISION' ? this.getJevProvider() : null;

    const model = capability === 'STRUCTURED_DECISION' ? opts.jev?.model ?? cfg.jevModel : null;
    const schemaVersion =
      capability === 'STRUCTURED_DECISION' ? opts.jev?.schemaVersion ?? 'unspecified' : null;
    const fingerprint = this.computeFingerprint(
      capability,
      kind,
      model,
      schemaVersion,
      symbol,
      material.fingerprintParts,
    );
    const fph = fingerprintHash(fingerprint);
    const skipCtx = { kind, symbol, traceId, fingerprintHash: fph };

    this.diag.considered++;
    this.emit('AI_CALL_CONSIDERED', { kind, symbol, traceId, fingerprintHash: fph });

    // 1. DISABLED (governor or capability off)
    if (!isAiCallGovernorEnabled()) {
      return this.skip('DISABLED', 'aiGovernorEnabled=false: deny-all, zero AI calls', skipCtx);
    }
    if (capability === 'STRUCTURED_DECISION' && !isJevCapabilityEnabled()) {
      return this.skip('DISABLED', 'jevEnabled=false: STRUCTURED_DECISION capability off', skipCtx);
    }
    // (GENERATIVE_ANALYSIS has no separate capability flag in config; the
    // master switch plus executor registration govern it.)

    // 2. STALE_EVENT
    if (now > material.decisionDeadlineMs) {
      return this.skip(
        'STALE_EVENT',
        `decisionDeadlineMs ${material.decisionDeadlineMs} already passed`,
        skipCtx,
      );
    }

    // 3. DEADLINE_TOO_CLOSE
    if (now + cfg.aiDecisionDeadlineMinLeadMs > material.decisionDeadlineMs) {
      return this.skip(
        'DEADLINE_TOO_CLOSE',
        `only ${material.decisionDeadlineMs - now}ms remain, need >= ${cfg.aiDecisionDeadlineMinLeadMs}ms lead`,
        skipCtx,
      );
    }

    // 4. NOT_MATERIAL
    const minMateriality = MIN_MATERIALITY_BY_KIND[kind] ?? DEFAULT_MIN_MATERIALITY;
    if (MATERIALITY_RANK[material.materiality] < MATERIALITY_RANK[minMateriality]) {
      return this.skip(
        'NOT_MATERIAL',
        `materiality ${material.materiality} below minimum ${minMateriality} for kind ${kind}`,
        skipCtx,
      );
    }

    // 5. CACHE_HIT
    const cached = this.cache.get(fingerprint);
    if (cached && now - cached.storedAt <= cached.ttlMs) {
      // LRU touch: re-insert to mark recently used.
      this.cache.delete(fingerprint);
      this.cache.set(fingerprint, cached);
      this.diag.cacheHits++;
      this.emit('AI_CACHE_HIT', { kind, symbol, traceId, fingerprintHash: fph });
      return { status: 'CACHE_HIT', result: cached.value as T };
    }
    if (cached) this.cache.delete(fingerprint); // expired entry

    // 6. DUPLICATE / singleflight: join the in-flight call, never start a second.
    const inflight = this.inFlight.get(fingerprint);
    if (inflight) {
      this.diag.singleflightJoins++;
      this.emit('AI_SINGLEFLIGHT_JOINED', { kind, symbol, traceId, fingerprintHash: fph });
      this.diag.skips['DUPLICATE'] = (this.diag.skips['DUPLICATE'] ?? 0) + 1;
      return (await inflight) as GovernorResult<T>;
    }

    // 7. SYMBOL_COOLDOWN
    if (symbol) {
      this.pruneSymbolCooldowns(now);
      const lastAt = this.symbolCooldownAt.get(symbol);
      if (lastAt !== undefined && now - lastAt < cfg.aiPerSymbolCooldownMs) {
        return this.skip(
          'SYMBOL_COOLDOWN',
          `symbol ${symbol} called ${now - lastAt}ms ago, cooldown ${cfg.aiPerSymbolCooldownMs}ms`,
          skipCtx,
        );
      }
    }

    // 8. GLOBAL_BUDGET (sliding per-minute window)
    if (this.globalWindow.peekExceeded(now, cfg.aiGlobalOptionalCallsPerMinute)) {
      return this.skip(
        'GLOBAL_BUDGET',
        `global optional-AI budget ${cfg.aiGlobalOptionalCallsPerMinute}/min exhausted`,
        skipCtx,
      );
    }

    // 9. PROVIDER_BUDGET (per-capability) and per-symbol per-minute budget
    const providerBudget =
      providerKey === 'jev' ? cfg.jevCallsPerMinute : cfg.generativeCallsPerMinute;
    if (this.providerWindows[providerKey].peekExceeded(now, providerBudget)) {
      return this.skip(
        'PROVIDER_BUDGET',
        `${providerKey} budget ${providerBudget}/min exhausted`,
        skipCtx,
      );
    }
    if (symbol && this.symbolWindow(symbol).peekExceeded(now, cfg.aiPerSymbolCallsPerMinute)) {
      return this.skip(
        'PROVIDER_BUDGET',
        `per-symbol budget ${cfg.aiPerSymbolCallsPerMinute}/min exhausted for ${symbol}`,
        skipCtx,
      );
    }

    // 10. PROVIDER_UNHEALTHY (Jev without a usable key -> NO_API_KEY)
    if (capability === 'STRUCTURED_DECISION') {
      let configured = false;
      try {
        configured = !!jevProvider && jevProvider.isConfigured();
      } catch {
        configured = false;
      }
      if (!jevProvider || !configured || this.providerUnhealthy.jev) {
        const detail = !jevProvider
          ? 'JevDecisionProvider unavailable'
          : this.providerUnhealthy.jev
            ? 'Jev provider marked unhealthy after AUTH/VALIDATION failure (no usable JEV_API_KEY)'
            : 'Jev provider reports not configured (no usable JEV_API_KEY)';
        return this.skip('NO_API_KEY', detail, skipCtx);
      }
    } else if (!this.generativeExecutor) {
      return this.skip('PROVIDER_UNHEALTHY', 'no generative executor registered', skipCtx);
    }

    // 11. CIRCUIT_OPEN (with HALF_OPEN probe allowance after cooldown)
    const circuit = this.circuits[providerKey];
    if (circuit.state === 'OPEN') {
      if (now - circuit.openedAt >= cfg.jevCircuitOpenCooldownMs) {
        circuit.state = 'HALF_OPEN';
        circuit.halfOpenProbesUsed = 0;
        this.emit('AI_PROVIDER_HALF_OPEN', {
          kind,
          symbol,
          traceId,
          provider: providerKey,
          fingerprintHash: fph,
        });
      } else {
        return this.skip(
          'CIRCUIT_OPEN',
          `${providerKey} circuit OPEN (${circuit.consecutiveFailures} consecutive failures)`,
          skipCtx,
        );
      }
    }
    if (circuit.state === 'HALF_OPEN' && circuit.halfOpenProbesUsed >= cfg.jevHalfOpenMaxProbes) {
      return this.skip(
        'CIRCUIT_OPEN',
        `${providerKey} circuit HALF_OPEN probe budget (${cfg.jevHalfOpenMaxProbes}) exhausted`,
        skipCtx,
      );
    }

    // 12. QUEUE_FULL (bounded concurrency: maxInFlight executing + queueLimit
    //     tolerated in flight; beyond that we skip rather than queue unboundedly)
    const queueCapacity = cfg.jevMaxInFlight + cfg.jevQueueLimit;
    if (this.inFlightCount[providerKey] >= queueCapacity) {
      return this.skip(
        'QUEUE_FULL',
        `${providerKey} in-flight ${this.inFlightCount[providerKey]} >= capacity ${queueCapacity}`,
        skipCtx,
      );
    }

    // 13. SHOULD_CALL - consume budget tokens, stamp cooldown, run the call.
    const acquiredGlobal = this.globalWindow.tryAcquire(now, cfg.aiGlobalOptionalCallsPerMinute);
    const acquiredProvider = this.providerWindows[providerKey].tryAcquire(now, providerBudget);
    const acquiredSymbol = symbol
      ? this.symbolWindow(symbol).tryAcquire(now, cfg.aiPerSymbolCallsPerMinute)
      : true;
    if (!acquiredGlobal) return this.skip('GLOBAL_BUDGET', 'global budget race lost', skipCtx);
    if (!acquiredProvider || !acquiredSymbol) {
      return this.skip('PROVIDER_BUDGET', 'provider/symbol budget race lost', skipCtx);
    }
    if (symbol) this.symbolCooldownAt.set(symbol, now);
    if (circuit.state === 'HALF_OPEN') circuit.halfOpenProbesUsed++;
    this.inFlightCount[providerKey]++;
    this.diag.called++;

    const timeoutMs = defaultCallTimeoutMs();
    const ttlMs = opts.ttlMs ?? cfg.cacheTtlMsByKind[kind] ?? DEFAULT_CACHE_TTL_MS;
    const startedAt = this.now();
    this.emit('AI_CALL_STARTED', {
      kind,
      symbol,
      traceId,
      provider: providerKey,
      fingerprintHash: fph,
    });

    const execPromise = this.executeCall<T>({
      capability,
      providerKey,
      kind,
      symbol,
      traceId,
      fingerprint,
      fingerprintHash: fph,
      model,
      opts,
      jevProvider,
      timeoutMs,
      ttlMs,
      startedAt,
    });
    // Register synchronously: every step above this point is synchronous, so a
    // concurrent duplicate request can only arrive after this registration and
    // will join via singleflight instead of starting a second provider call.
    this.inFlight.set(fingerprint, execPromise as Promise<GovernorResult<unknown>>);
    try {
      return await execPromise;
    } finally {
      if (this.inFlight.get(fingerprint) === execPromise) this.inFlight.delete(fingerprint);
    }
  }

  private async executeCall<T>(args: {
    capability: AiCapability;
    providerKey: ProviderKey;
    kind: string;
    symbol?: string;
    traceId?: string;
    fingerprint: string;
    fingerprintHash: string;
    model: string | null;
    opts: GovernorRequestOpts<T>;
    jevProvider: JevProviderHandle | null;
    timeoutMs: number;
    ttlMs: number;
    startedAt: number;
  }): Promise<GovernorResult<T>> {
    const {
      capability,
      providerKey,
      kind,
      symbol,
      traceId,
      fingerprint,
      fingerprintHash: fph,
      opts,
      jevProvider,
      timeoutMs,
      ttlMs,
      startedAt,
    } = args;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const invoke: Promise<{ value: T; cacheable: boolean }> =
        capability === 'STRUCTURED_DECISION'
          ? this.invokeJev<T>(jevProvider, opts, timeoutMs, controller.signal)
          : this.invokeGenerative<T>(timeoutMs, controller.signal);
      // Suppress unhandled-rejection noise if the timeout path wins the race
      // and the provider promise settles later.
      invoke.catch(() => undefined);
      const outcome = await Promise.race([
        invoke,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(timeoutError(timeoutMs));
          }, timeoutMs);
          const t = timer as unknown as { unref?: () => void };
          if (typeof t.unref === 'function') t.unref();
        }),
      ]);

      const latencyMs = this.now() - startedAt;
      this.recordProviderSuccess(providerKey);
      if (outcome.cacheable) {
        this.cacheSet(fingerprint, outcome.value, ttlMs);
      }
      this.diag.latencies.push(latencyMs);
      if (this.diag.latencies.length > MAX_LATENCY_SAMPLES) {
        this.diag.latencies.splice(0, this.diag.latencies.length - MAX_LATENCY_SAMPLES);
      }
      this.emit('AI_CALL_COMPLETED', {
        kind,
        symbol,
        traceId,
        provider: providerKey,
        latencyMs,
        fingerprintHash: fph,
      });
      if (capability === 'STRUCTURED_DECISION') {
        const decideResult = outcome.value as unknown as {
          model?: unknown;
          inputTokens?: unknown;
        };
        this.emit('JEV_DECISION_COMPLETED', {
          kind,
          symbol,
          traceId,
          latencyMs,
          fingerprintHash: fph,
          extra: {
            jevModel: typeof decideResult?.model === 'string' ? decideResult.model : undefined,
            inputTokens:
              typeof decideResult?.inputTokens === 'number' ? decideResult.inputTokens : undefined,
          },
        });
      }
      return { status: 'CALLED', result: outcome.value, latencyMs };
    } catch (err) {
      // Defensive: the default generative executor throws when none is
      // registered; treat as SKIPPED (provider unavailable), never FAILED.
      if (err instanceof Error && err.message === 'no generative executor registered') {
        return this.skip('PROVIDER_UNHEALTHY', 'no generative executor registered', {
          kind,
          symbol,
          traceId,
          fingerprintHash: fph,
        });
      }
      const failureKind = classifyFailureKind(err);
      this.recordProviderFailure(providerKey, failureKind, {
        kind,
        symbol,
        traceId,
        fingerprintHash: fph,
      });
      // FAILED never throws to the caller; no fallback to the other
      // capability, ever.
      return { status: 'FAILED', error: err, kind: failureKind };
    } finally {
      if (timer) clearTimeout(timer);
      // Clamp at zero: resetForTests() may zero the counter while a call is
      // still in flight (tests); a stale finally must not drive it negative.
      this.inFlightCount[providerKey] = Math.max(0, this.inFlightCount[providerKey] - 1);
    }
  }

  private async invokeJev<T>(
    provider: JevProviderHandle | null,
    opts: GovernorRequestOpts<T>,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ value: T; cacheable: boolean }> {
    const spec = opts.jev;
    if (!provider || !spec) {
      // Caller bug (STRUCTURED_DECISION without a jev spec): fail closed.
      // Classified VALIDATION so it never trips the circuit breaker.
      const err = new Error(
        'STRUCTURED_DECISION requires opts.jev { state, questions, schemaVersion }',
      );
      (err as unknown as { kind: string }).kind = 'VALIDATION';
      throw err;
    }
    const model = spec.model ?? aiCallGovernor.jevModel;
    const req: JevDecisionRequest = {
      state: spec.state,
      questions: spec.questions as unknown as Record<string, JevQuestion>,
      model,
      schemaVersion: spec.schemaVersion,
      timeoutMs,
      signal,
    };
    const res = await provider.decide(req);
    // Jev structured decisions are deterministic triage answers keyed by the
    // fingerprint: always cacheable under the governor TTL policy.
    return { value: res as unknown as T, cacheable: true };
  }

  private async invokeGenerative<T>(
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ value: T; cacheable: boolean }> {
    const executor =
      this.generativeExecutor ??
      (async () => {
        throw new Error('no generative executor registered');
      });
    const res = await executor({ signal, timeoutMs });
    return { value: res.value as T, cacheable: res.cacheable };
  }

  private cacheSet(fingerprint: string, value: unknown, ttlMs: number): void {
    if (this.cache.has(fingerprint)) this.cache.delete(fingerprint);
    this.cache.set(fingerprint, { value, storedAt: this.now(), ttlMs });
    // Simple LRU eviction: Map preserves insertion order; drop the oldest.
    while (this.cache.size > aiCallGovernor.aiStateCacheMaxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  private recordProviderSuccess(providerKey: ProviderKey): void {
    const circuit = this.circuits[providerKey];
    const wasDegraded = circuit.state !== 'CLOSED' || this.providerUnhealthy[providerKey];
    circuit.state = 'CLOSED';
    circuit.consecutiveFailures = 0;
    circuit.halfOpenProbesUsed = 0;
    this.providerUnhealthy[providerKey] = false;
    if (wasDegraded) {
      this.emit('AI_PROVIDER_RECOVERED', { provider: providerKey });
    }
  }

  private recordProviderFailure(
    providerKey: ProviderKey,
    failureKind: string,
    ctx: { kind: string; symbol?: string; traceId?: string; fingerprintHash: string },
  ): void {
    this.diag.failures++;
    if (failureKind === 'TIMEOUT') this.diag.timeouts++;
    this.emit('AI_CALL_FAILED', {
      kind: ctx.kind,
      symbol: ctx.symbol,
      traceId: ctx.traceId,
      provider: providerKey,
      fingerprintHash: ctx.fingerprintHash,
      extra: { failureKind },
    });
    if (CIRCUIT_TRIPPING_KINDS.has(failureKind)) {
      const circuit = this.circuits[providerKey];
      circuit.consecutiveFailures++;
      const threshold = aiCallGovernor.jevConsecutiveFailureThreshold;
      if (circuit.state === 'HALF_OPEN' || circuit.consecutiveFailures >= threshold) {
        const wasAlreadyOpen = circuit.state === 'OPEN';
        circuit.state = 'OPEN';
        circuit.openedAt = this.now();
        circuit.halfOpenProbesUsed = 0;
        if (!wasAlreadyOpen) {
          this.emit('AI_PROVIDER_CIRCUIT_OPENED', {
            provider: providerKey,
            extra: {
              consecutiveFailures: circuit.consecutiveFailures,
              threshold,
              failureKind,
            },
          });
        }
      }
    } else if (NON_TRIpping_KINDS.has(failureKind)) {
      // 401/422-style: bad key or bad request, not a sick provider. Do not
      // trip the breaker; mark unhealthy so later calls skip cheaply instead
      // of burning budget against a doomed provider.
      this.providerUnhealthy[providerKey] = true;
    }
  }

  getDiagnostics(): {
    considered: number;
    called: number;
    cacheHits: number;
    singleflightJoins: number;
    skips: Record<string, number>;
    failures: number;
    timeouts: number;
    latencyMs: { p50: number; p95: number; p99: number };
    inFlight: number;
    circuits: Record<string, 'CLOSED' | 'OPEN' | 'HALF_OPEN'>;
    cacheSize: number;
    /** Per-symbol budget/cooldown tracking (bounded: MAX_SYMBOL_BUCKETS). */
    symbolWindows: number;
    symbolCooldowns: number;
  } {
    const sorted = [...this.diag.latencies].sort((a, b) => a - b);
    const pct = (p: number): number => {
      if (sorted.length === 0) return 0;
      return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    };
    return {
      considered: this.diag.considered,
      called: this.diag.called,
      cacheHits: this.diag.cacheHits,
      singleflightJoins: this.diag.singleflightJoins,
      skips: { ...this.diag.skips },
      failures: this.diag.failures,
      timeouts: this.diag.timeouts,
      latencyMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) },
      inFlight: this.inFlightCount.jev + this.inFlightCount.generative,
      circuits: { jev: this.circuits.jev.state, generative: this.circuits.generative.state },
      cacheSize: this.cache.size,
      symbolWindows: this.symbolWindows.size,
      symbolCooldowns: this.symbolCooldownAt.size,
    };
  }

  getAvoidanceStats(): { considered: number; avoided: number; avoidanceRate: number } {
    const considered = this.diag.considered;
    const avoided = considered - this.diag.called;
    return {
      considered,
      avoided,
      avoidanceRate: considered > 0 ? avoided / considered : 0,
    };
  }

  resetForTests(): void {
    this.cache.clear();
    this.inFlight.clear();
    this.inFlightCount.jev = 0;
    this.inFlightCount.generative = 0;
    for (const key of ['jev', 'generative'] as ProviderKey[]) {
      this.circuits[key] = {
        state: 'CLOSED',
        consecutiveFailures: 0,
        openedAt: 0,
        halfOpenProbesUsed: 0,
      };
      this.providerUnhealthy[key] = false;
      this.providerWindows[key].reset();
    }
    this.globalWindow.reset();
    this.symbolWindows.clear();
    this.symbolCooldownAt.clear();
    this.diag.considered = 0;
    this.diag.called = 0;
    this.diag.cacheHits = 0;
    this.diag.singleflightJoins = 0;
    this.diag.skips = {};
    this.diag.failures = 0;
    this.diag.timeouts = 0;
    this.diag.latencies = [];
    this.generativeExecutor = null;
    this.jevProviderOverride = undefined;
    this.nowFn = () => Date.now();
  }

  /**
   * Test-only: inject a fake clock (ms). resetForTests() restores Date.now().
   * Lets tests exercise cooldowns/budgets/circuits without real waiting.
   */
  __setClockForTests(fn: () => number): void {
    this.nowFn = fn;
  }

  /**
   * Test-only: inject a fake JevDecisionProvider (or null to force "absent").
   * resetForTests() clears the override.
   */
  __setJevProviderForTests(provider: JevProviderHandle | null): void {
    this.jevProviderOverride = provider;
  }
}
