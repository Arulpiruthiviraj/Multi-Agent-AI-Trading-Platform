/**
 * ==========================================================
 * Module: quantPriorityScheduler
 *
 * Purpose:
 * Bounded, priority-aware scheduling control-plane for QuantSignalAgent evaluations.
 * Replaces the "snapshot the universe, grind through it with a worker pool, late movers
 * wait for the next cycle" model that the 2026-10-09 forensic audit measured at
 * admission->Quant-completion p50 12.9min / p95 63.7min / max 193min (MRNA admitted
 * 10:27, promoted 10:29, assessed 17:14 - after close; CRCL admitted+promoted but never
 * assessed at all).
 *
 * What this module is: a CONTROL PLANE. It decides WHEN a candidate is evaluated, in
 * what order, with what bounded resources, and with what deadline - and it guarantees
 * every admitted candidate resolves to exactly one observable terminal state. It never
 * decides WHETHER an evaluation becomes a trade: priority affects scheduling only, never
 * RiskEngine/ChiefTrader/consensus outcomes, never any gate, threshold, or strategy
 * selection. evaluateSymbol()'s signature and behavior contract are untouched; the
 * scheduler calls it as a black box through injected dependencies.
 *
 * Pipeline per candidate (a worker never holds a compute slot while blocked on
 * unrelated external I/O):
 *   ADMITTED -> QUEUED (priority queue) -> DATA_READINESS_CHECK (cheap cache read)
 *     -> [insufficient/stale] DATA_FETCH_QUEUE (bounded data-fetch pool, provider
 *        fetch with timeout, outside any quant slot)
 *     -> QUANT_READY -> QUANT_WORKER (bounded quant pool, priority-ordered handoff)
 *     -> exactly one terminal state.
 *
 * Terminal states (invariant: every admitted candidate reaches exactly one):
 *   ASSESSED            - evaluateSymbol() returned a real evaluation (idea or honest
 *                         no-idea assessment; never asserts BUY - timeliness only).
 *   DATA_UNAVAILABLE    - data could not be made sufficient (fetch per policy, still
 *                         insufficient; or evaluateSymbol's own INSUFFICIENT_BARS path).
 *   PROVIDER_TIMEOUT    - a provider fetch hung past quantSchedulerDataFetchTimeoutMs.
 *   PROVIDER_BACKOFF    - provider rate-limit (429 wording) surfaced or the gateway's
 *                         own rate-limit backoff was already armed.
 *   EXPIRED             - the candidate's own expiresAt passed before assessment
 *                         (candidate-level TTL, e.g. fast-lane candidates).
 *   EVICTED             - queue overflow: preempted by a strictly higher-priority
 *                         admission, or rejected because the queue is full of
 *                         equal-or-higher-priority work.
 *   NOT_ELIGIBLE        - admission rejected (scheduler stopped/not initialized, or
 *                         invalid symbol). Never silently dropped - terminal at admit.
 *   ERROR               - unexpected failure in the evaluation path (non-429 throw).
 *   ASSESSMENT_EXPIRED  - the per-priority assessment deadline passed. A 20-min-late
 *                         evaluation is never presented as current: a queued candidate
 *                         past deadline transitions immediately; an in-flight evaluation
 *                         that settles late is recorded as ASSESSMENT_EXPIRED with
 *                         evaluationSettledLate=true (its late result is not treated as
 *                         a current assessment).
 *
 * Concurrency model (provider-aware, NOT cranked):
 *   - quantWorkerPoolSize separate bounded pool for evaluateSymbol() calls.
 *   - dataFetchPoolSize separate bounded pool for scheduler-initiated ensureBars()
 *     pre-fetches. A slow provider fetch for symbol A can never hold a quant slot
 *     needed by B/C/D.
 *   - Java bridge calls: NOT a scheduler semaphore. They happen inside evaluateSymbol
 *     (QuantCoreBridge) and are bounded there (quantJavaCoreRequestTimeoutMs=100ms,
 *     circuit breaker, quantJavaCoreTickMaxConcurrency). The scheduler records
 *     javaStartedAt/FinishedAt as null with the reason documented on the field - the
 *     per-call timing is owned by QuantCoreBridge observability, not this module.
 *     Inventing timestamps here would be fabrication.
 *   - AI: fully separate budget, never drawn from scheduler pools (AICallGovernor +
 *     analyzeContradictionsBounded's quantContradictionMaxWaitMs latency bound).
 *   Provider burst protection lives in HistoricalDataGateway itself (Alpaca pace chain
 *   <=150/min, per-window in-flight coalescing, reactive 429 backoff) - the scheduler
 *   pools bound OUR in-flight work so slow I/O cannot starve compute, they do not
 *   replace the gateway's own pacing. Chosen values and the measurement procedure to
 *   raise them with evidence: docs/testing/QUANT_SCHEDULER_CAPACITY.md.
 *
 * Singleflight dedup (symbol + evaluation-fingerprint):
 *   Concurrent admissions for the same symbol+fingerprint coalesce onto the one
 *   in-flight evaluation instead of running duplicates (same coalescing philosophy as
 *   src/server/core/singleFlightInterval.ts, adapted to promise-sharing rather than
 *   skip-if-running because a late admitter still needs the outcome). Recently-terminal
 *   outcomes are remembered for quantSchedulerDedupWindowMs so immediate re-admission
 *   (e.g. next cycle re-admitting the same universe) dedups instead of re-evaluating.
 *   registerExternalEvaluation() lets the Fast Lane register its own in-flight
 *   evaluation so the scheduler will not duplicate it - coordination point with
 *   fastLaneEvaluator.ts's own inFlightBySymbol dedup, which this module never touches
 *   or breaks (additive API only).
 *
 * Deadlines: intraday candidates carry a per-priority assessment deadline
 * (quantSchedulerP{0,1,2,3}DeadlineMs, config, not literals). The sweeper
 * (quantSchedulerSweepIntervalMs) transitions overdue queued candidates; in-flight
 * overruns are marked at settle time (see ASSESSMENT_EXPIRED above). Separately, the
 * quant STAGE has its own liveness watchdog (quantSchedulerQuantEvaluationTimeoutMs):
 * a hung evaluateSymbol() is quarantined - its slot returns to the pool while the
 * dedup entry is kept, so pool-size hangs cannot wedge throughput; the sweeper
 * evicts quarantines older than quantSchedulerQuantQuarantineMaxAgeMs.
 *
 * Feature flag: QUANT_PRIORITY_SCHEDULER_ENABLED (default off). QuantSignalAgent keeps
 * its existing runCycle fan-out unless the flag is on - default path is byte-for-byte
 * the old behavior. isQuantPrioritySchedulerEnabled() in config/tradingSafety.ts.
 *
 * 2026-10-09 (P2 scheduler mission, Task C). Control-plane only: no strategy,
 * threshold, lifecycle, consensus, RiskEngine, OMS, or broker changes. PAPER-only.
 * ==========================================================
 */
import { generateTraceId } from '../core/traceId';
import { tradingSafety, isQuantPrioritySchedulerEnabled } from '../config/tradingSafety';

/** P0 urgent mover / strong catalyst; P1 promoted dynamic candidate; P2 normal active
 *  symbol; P3 background refresh. Priority affects WHEN a candidate is evaluated -
 *  NEVER whether Risk approves or any gate outcome. */
export const QuantCandidatePriority = {
  P0_URGENT_MOVER: 0,
  P1_PROMOTED: 1,
  P2_NORMAL: 2,
  P3_BACKGROUND: 3,
} as const;
export type QuantCandidatePriority =
  (typeof QuantCandidatePriority)[keyof typeof QuantCandidatePriority];

/** Scheduling-level priority class used by the SLA test. P0/P1 share the HIGH SLA;
 *  P2 is NORMAL; P3 is best-effort background (deadline-bounded, may honestly expire). */
export type QuantPriorityClass = 'HIGH' | 'NORMAL' | 'BACKGROUND';
export function priorityClassOf(p: QuantCandidatePriority): QuantPriorityClass {
  if (p === QuantCandidatePriority.P0_URGENT_MOVER || p === QuantCandidatePriority.P1_PROMOTED) return 'HIGH';
  if (p === QuantCandidatePriority.P2_NORMAL) return 'NORMAL';
  return 'BACKGROUND';
}

export type QuantTerminalState =
  | 'ASSESSED'
  | 'DATA_UNAVAILABLE'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_BACKOFF'
  | 'EXPIRED'
  | 'EVICTED'
  | 'NOT_ELIGIBLE'
  | 'ERROR'
  | 'ASSESSMENT_EXPIRED';

/** Per-stage instrumentation. Every timestamp is a wall-clock ms (Date.now()).
 *  A delay is attributable by diffing adjacent stages; the terminal event carries all
 *  of them. javaStartedAt/FinishedAt are null in this phase: Java bridge calls inside
 *  evaluateSymbol are fire-and-forget shadow calls whose per-call timing is owned by
 *  QuantCoreBridge observability - recording invented values here would be fabrication.
 *  They become non-null if/when QuantCoreBridge exposes per-call timing hooks. */
export interface QuantStageTimestamps {
  admittedAtMs: number;
  queuedAtMs: number;
  dataReadinessCheckedAtMs: number | null;
  dataFetchStartedAtMs: number | null;
  dataFetchFinishedAtMs: number | null;
  quantStartedAtMs: number | null;
  javaStartedAtMs: null;
  javaFinishedAtMs: null;
  quantFinishedAtMs: number | null;
  terminalAtMs: number | null;
}

export interface CandidateOutcome {
  candidateId: string;
  symbol: string;
  priority: QuantCandidatePriority;
  priorityClass: QuantPriorityClass;
  source: string;
  terminalState: QuantTerminalState;
  reasonCode: string;
  stages: QuantStageTimestamps;
  /** admission->quant-start and admission->terminal latencies (ms). */
  admissionToQuantStartMs: number | null;
  admissionToTerminalMs: number;
  /** True when the candidate coalesced onto an already-tracked evaluation. */
  deduped: boolean;
  /** True when the evaluation settled after its assessment deadline (terminal is
   *  ASSESSMENT_EXPIRED, never presented as a current assessment). */
  evaluationSettledLate: boolean;
}

export interface QuantSchedulerCandidate {
  symbol: string;
  priority: QuantCandidatePriority;
  /** Where the admission came from: CYCLE | FAST_LANE | CONFLUENCE | MANUAL | MOVER | BACKGROUND */
  source: string;
  /** Dedup key component. Defaults to timeframe + emit-mode; callers with a richer
   *  notion of "same evaluation" (e.g. fast lane) supply their own. */
  evaluationFingerprint?: string;
  /** Candidate-level TTL (fast-lane style). Past it while queued -> EXPIRED. */
  expiresAtMs?: number | null;
  /** Passed through to evaluateSymbol. Default true (production); false for pure
   *  research evaluations (fast-lane D1 rule). */
  emitIdeas?: boolean;
  /** Opaque correlation metadata for evaluateSymbol (cycleId/scheduledIndex). */
  cycleCtx?: { cycleId: string; scheduledIndex: number };
}

export type AdmissionResult =
  | { accepted: true; candidateId: string; deduped: boolean; outcome: Promise<CandidateOutcome> }
  | {
      accepted: false;
      candidateId: string;
      deduped: false;
      /** Immediate terminal (NOT_ELIGIBLE / EVICTED) - emitted at admit, never silent. */
      terminalState: 'NOT_ELIGIBLE' | 'EVICTED';
      reasonCode: string;
      outcome: Promise<CandidateOutcome>;
    }
  | {
      accepted: false;
      candidateId: null;
      deduped: true;
      /** An external (fast-lane) evaluation owns this symbol+fingerprint - the scheduler
       *  will not duplicate it. The external system owns that evaluation's lifecycle;
       *  this outcome resolves to whatever the external promise settles with. */
      externalInFlight: true;
      outcome: Promise<unknown>;
    };

/** Outcome of the watchdog-wrapped quant stage: either the evaluation completed
 *  (with its value or thrown error) or the watchdog quarantined it. */
export type QuantStageOutcome =
  | { quarantined: false; evaluation: unknown; threw: unknown }
  | { quarantined: true };

/** All scheduler knobs live in config/tradingSafety.json (never literals, never .env -
 *  .env carries only the feature-flag). Tests must read expected values from the same
 *  config production loads (repo AGENTS.md). */
export interface QuantSchedulerConfig {
  quantWorkerPoolSize: number;
  dataFetchPoolSize: number;
  maxQueueDepth: number;
  dataFetchTimeoutMs: number;
  /** Liveness watchdog for a single quant-stage evaluateSymbol() call. On expiry the
   *  quant slot is QUARANTINED (returned to the pool) while the dedup entry is kept:
   *  capacity recovers, duplicate work is impossible, and a late settle is discarded.
   *  evaluateSymbol() has no safe cancellation, so holding the slot forever would let
   *  pool-size hangs wedge quant throughput permanently. Mirrors the fast-lane
   *  hung-lease quarantine (27e17d3). Generous on purpose: the data-fetch leg already
   *  ran, so a working evaluation should settle well inside this. */
  quantEvaluationTimeoutMs: number;
  /** Maximum age of a quarantined (watchdog-timed-out, still unsettled) quant
   *  evaluation before the sweeper evicts it and releases the dedup entry. Bounds
   *  orphaned-work state: hung work must not pin a symbol's dedup key forever. */
  quantQuarantineMaxAgeMs: number;
  /** Maximum age of an external (fast-lane) evaluation registration before the
   *  sweeper evicts it. A crashed external system must not block a symbol's
   *  scheduler evaluation forever. */
  externalRegistrationMaxAgeMs: number;
  dedupWindowMs: number;
  sweepIntervalMs: number;
  p0DeadlineMs: number;
  p1DeadlineMs: number;
  p2DeadlineMs: number;
  p3DeadlineMs: number;
  highPriorityAdmissionToStartSlaMs: number;
  highPriorityAdmissionToCompleteSlaMs: number;
  normalAdmissionToStartSlaMs: number;
  normalAdmissionToCompleteSlaMs: number;
  maxBatchWaitMs: number;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Resolves scheduler config from tradingSafety; `overrides` exist for unit tests only
 *  (deadline mechanics, pool saturation) - production always passes none. */
export function resolveQuantSchedulerConfig(
  overrides?: Partial<QuantSchedulerConfig>,
): QuantSchedulerConfig {
  const cfg: QuantSchedulerConfig = {
    quantWorkerPoolSize: num(tradingSafety.quantSchedulerQuantWorkerPoolSize, 4),
    dataFetchPoolSize: num(tradingSafety.quantSchedulerDataFetchPoolSize, 4),
    maxQueueDepth: num(tradingSafety.quantSchedulerMaxQueueDepth, 200),
    dataFetchTimeoutMs: num(tradingSafety.quantSchedulerDataFetchTimeoutMs, 30_000),
    quantEvaluationTimeoutMs: num(tradingSafety.quantSchedulerQuantEvaluationTimeoutMs, 120_000),
    quantQuarantineMaxAgeMs: num(tradingSafety.quantSchedulerQuantQuarantineMaxAgeMs, 600_000),
    externalRegistrationMaxAgeMs: num(tradingSafety.quantSchedulerExternalRegistrationMaxAgeMs, 300_000),
    dedupWindowMs: num(tradingSafety.quantSchedulerDedupWindowMs, 300_000),
    sweepIntervalMs: num(tradingSafety.quantSchedulerSweepIntervalMs, 5_000),
    p0DeadlineMs: num(tradingSafety.quantSchedulerP0DeadlineMs, 60_000),
    p1DeadlineMs: num(tradingSafety.quantSchedulerP1DeadlineMs, 120_000),
    p2DeadlineMs: num(tradingSafety.quantSchedulerP2DeadlineMs, 300_000),
    p3DeadlineMs: num(tradingSafety.quantSchedulerP3DeadlineMs, 900_000),
    highPriorityAdmissionToStartSlaMs: num(tradingSafety.quantSchedulerHighPriorityAdmissionToStartSlaMs, 30_000),
    highPriorityAdmissionToCompleteSlaMs: num(tradingSafety.quantSchedulerHighPriorityAdmissionToCompleteSlaMs, 60_000),
    normalAdmissionToStartSlaMs: num(tradingSafety.quantSchedulerNormalAdmissionToStartSlaMs, 60_000),
    normalAdmissionToCompleteSlaMs: num(tradingSafety.quantSchedulerNormalAdmissionToCompleteSlaMs, 120_000),
    maxBatchWaitMs: num(tradingSafety.quantSchedulerMaxBatchWaitMs, 240_000),
  };
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (v !== undefined) (cfg as unknown as Record<string, number>)[k] = v;
    }
  }
  return cfg;
}

/** Minimal bar shape the readiness check needs (timestamp only). */
export interface SchedulerBar {
  timestamp: number;
}

export interface QuantSchedulerDeps {
  /** evaluateSymbol's contract is unchanged - the scheduler is a black-box caller. */
  evaluateSymbol: (
    symbol: string,
    options?: { emitIdeas?: boolean; cycleCtx?: { cycleId: string; scheduledIndex: number } },
  ) => Promise<unknown>;
  /** Cache read (cheap, bounded). Production: historicalDataGateway.getBars. */
  getBars: (symbol: string, timeframe: string, startMs: number, endMs: number) => Promise<SchedulerBar[]>;
  /** Provider fetch (slow, bounded by the data-fetch pool + timeout). Production:
   *  historicalDataGateway.ensureBars. */
  ensureBars: (symbol: string, timeframe: string, startMs: number, endMs: number) => Promise<void>;
  /** Gateway's reactive 429 backoff horizon (ms epoch). Production:
   *  historicalDataGateway.getBarsRateLimitedUntilMs(). */
  providerRateLimitedUntilMs: () => number;
  /** regimeMinBars equivalent - the bar-count floor for a real evaluation. */
  minBars: number;
  /** Expected bar count for a window (coverage-ratio leg of the readiness check).
   *  Production: expectedBarCountForWindow from HistoricalDataGateway. The readiness
   *  check must mirror the gateway's own sufficiency contract (count OR coverage);
   *  without the coverage leg the scheduler would mark DATA_UNAVAILABLE for windows
   *  the gateway (and evaluateSymbol) would happily evaluate.
   *  Optional: when omitted the scheduler falls back to minBars as the expected
   *  count (coverage leg degrades to count/minBars, which is >= 1 whenever the
   *  count leg passes — i.e. the coverage leg becomes a no-op and readiness is
   *  decided by the count leg alone). */
  expectedBarCount?: (timeframe: string, startMs: number, endMs: number) => number;
  /** Lookback window (days) for the readiness check. Production: quantLookbackDays. */
  lookbackDays: number;
  timeframe?: string;
  config?: Partial<QuantSchedulerConfig>;
  now?: () => number;
  /** Structured observability sink. Default: lazy StructuredLogger (dynamic import so
   *  this module stays importable in DB-less unit tests - StructuredLogger pulls the
   *  DB layer at module load). */
  emit?: (eventType: string, fields: Record<string, unknown>) => void;
}

function defaultEmit(eventType: string, fields: Record<string, unknown>): void {
  const msg = eventType.toLowerCase();
  import('../observability/StructuredLogger')
    .then(({ observeSafe, structuredLogger }) => {
      observeSafe(() => structuredLogger.info(msg, { category: 'DISCOVERY', eventType, ...fields }));
    })
    .catch(() => {
      /* observability must never break scheduling */
    });
}

const RATE_LIMIT_WORDING = /429|rate-limited|Too Many Requests/i;

interface TrackedCandidate {
  candidateId: string;
  symbol: string;
  priority: QuantCandidatePriority;
  priorityClass: QuantPriorityClass;
  source: string;
  fingerprint: string;
  admittedAtMs: number;
  queuedAtMs: number;
  deadlineMs: number;
  expiresAtMs: number | null;
  emitIdeas: boolean;
  cycleCtx?: { cycleId: string; scheduledIndex: number };
  stages: QuantStageTimestamps;
  terminalState: QuantTerminalState | null;
  reasonCode: string | null;
  deduped: boolean;
  evaluationSettledLate: boolean;
  /** Set when the quant-stage watchdog fired and the slot was quarantined (released
   *  to the pool) while the underlying evaluation was still unsettled. The dedup
   *  entry is kept; the sweeper evicts the quarantine after quantQuarantineMaxAgeMs. */
  quantQuarantinedAtMs: number | null;
  resolveOutcome: (o: CandidateOutcome) => void;
  outcomePromise: Promise<CandidateOutcome>;
  /** Set when the sweeper (or a stage) observes the deadline pass while in flight. */
  deadlineExceededWhileInFlight: boolean;
}

/** Priority-ordered semaphore: waiters are granted in (priority, fifo-sequence) order,
 *  so a P0 admitted later still jumps ahead of queued P2/P3 work at slot handoff.
 *  In-flight work is never preempted (evaluateSymbol has no safe cancellation). */
class PrioritySemaphore {
  private permits: number;
  private seq = 0;
  private waiters: Array<{ priority: number; seq: number; resolve: (release: () => void) => void }> = [];

  constructor(permits: number) {
    this.permits = Math.max(1, Math.floor(permits));
  }

  acquire(priority: number): Promise<() => void> {
    // Immediate grant only when nobody is waiting - otherwise a newcomer could jump a
    // queued P0.
    if (this.permits > 0 && this.waiters.length === 0) {
      this.permits -= 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise((resolve) => {
      this.waiters.push({ priority, seq: this.seq++, resolve });
      this.waiters.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next.resolve(this.makeRelease());
      } else {
        this.permits += 1;
      }
    };
  }

  /** For tests/observability. */
  waitingCount(): number {
    return this.waiters.length;
  }
}

export interface QuantSchedulerMetrics {
  admitted: number;
  deduped: number;
  terminalByState: Record<string, number>;
  quantPoolWaiting: number;
  dataFetchPoolWaiting: number;
  tracked: number;
  /** Quant-stage watchdog quarantines currently outstanding (slot released, dedup
   *  kept, orphan unsettled). Bounded by the sweeper's quantQuarantineMaxAgeMs. */
  quantQuarantined: number;
}

export class QuantPriorityScheduler {
  private readonly deps: QuantSchedulerDeps;
  private readonly config: QuantSchedulerConfig;
  private readonly timeframe: string;
  private readonly emit: (eventType: string, fields: Record<string, unknown>) => void;
  private readonly now: () => number;

  private quantSem: PrioritySemaphore;
  private fetchSem: PrioritySemaphore;
  /** Candidates admitted and not yet terminal (queued or in a stage). */
  private tracked = new Map<string, TrackedCandidate>();
  /** Singleflight: key -> in-flight scheduler evaluation. */
  private inflight = new Map<string, TrackedCandidate>();
  /** Recently-terminal outcomes, for dedupWindowMs after settle. */
  private recentTerminal = new Map<string, { outcome: CandidateOutcome; terminalAtMs: number }>();
  /** External evaluations (fast lane) registered for coordination. */
  private externalInflight = new Map<string, { promise: Promise<unknown>; registeredAtMs: number }>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private started = false;
  private stopped = false;
  private metrics = {
    admitted: 0,
    deduped: 0,
    terminalByState: {} as Record<string, number>,
  };

  constructor(deps: QuantSchedulerDeps) {
    this.deps = deps;
    this.config = resolveQuantSchedulerConfig(deps.config);
    this.timeframe = deps.timeframe ?? '1Day';
    // Observability must never break scheduling or terminal accounting: a throwing
    // custom emit sink is neutralized here so every this.emit call site (including
    // setTerminal and the pipeline-failure guard) is total.
    const rawEmit = deps.emit ?? defaultEmit;
    this.emit = (eventType: string, fields: Record<string, unknown>) => {
      try {
        rawEmit(eventType, fields);
      } catch {
        /* observability must never break scheduling */
      }
    };
    this.now = deps.now ?? Date.now;
    this.quantSem = new PrioritySemaphore(this.config.quantWorkerPoolSize);
    this.fetchSem = new PrioritySemaphore(this.config.dataFetchPoolSize);
  }

  /** Starts the deadline sweeper. Idempotent. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.sweepTimer = setInterval(() => {
      try {
        this.sweep();
      } catch (e) {
        console.error('[quantPriorityScheduler] sweep failed', e);
      }
    }, this.config.sweepIntervalMs);
    // Never keep the process alive for observability bookkeeping alone.
    if (typeof (this.sweepTimer as unknown as { unref?: () => void }).unref === 'function') {
      (this.sweepTimer as unknown as { unref: () => void }).unref();
    }
  }

  /** Stops new admissions and the sweeper. In-flight candidates still settle to their
   *  terminal state (never silently dropped); already-queued ones are terminally
   *  transitioned as EVICTED with reason SCHEDULER_STOPPED. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const rec of [...this.tracked.values()]) {
      if (!rec.terminalState) this.setTerminal(rec, 'EVICTED', 'SCHEDULER_STOPPED');
    }
  }

  getMetrics(): QuantSchedulerMetrics {
    let quantQuarantined = 0;
    for (const rec of this.tracked.values()) {
      if (!rec.terminalState && rec.quantQuarantinedAtMs != null) quantQuarantined += 1;
    }
    return {
      admitted: this.metrics.admitted,
      deduped: this.metrics.deduped,
      terminalByState: { ...this.metrics.terminalByState },
      quantPoolWaiting: this.quantSem.waitingCount(),
      dataFetchPoolWaiting: this.fetchSem.waitingCount(),
      tracked: this.tracked.size,
      quantQuarantined,
    };
  }

  /** The resolved config this scheduler runs with (for runQuantSchedulerBatch and
   *  tests). Returned by copy - the scheduler's live config is never mutated. */
  getConfig(): QuantSchedulerConfig {
    return { ...this.config };
  }

  /** For tests: run the deadline/expiry sweep deterministically (no timers). */
  sweepForTests(): void {
    this.sweep();
  }

  /** True after stop(). A stopped scheduler rejects new admissions (NOT_ELIGIBLE). */
  isStopped(): boolean {
    return this.stopped;
  }

  private dedupKey(symbol: string, fingerprint: string): string {
    return `${symbol.toUpperCase()}|${fingerprint}`;
  }

  private defaultFingerprint(candidate: QuantSchedulerCandidate): string {
    return candidate.evaluationFingerprint ?? `${this.timeframe}|${candidate.emitIdeas === false ? 'eval' : 'emit'}`;
  }

  private deadlineFor(priority: QuantCandidatePriority, admittedAtMs: number): number {
    const c = this.config;
    const d =
      priority === QuantCandidatePriority.P0_URGENT_MOVER ? c.p0DeadlineMs
      : priority === QuantCandidatePriority.P1_PROMOTED ? c.p1DeadlineMs
      : priority === QuantCandidatePriority.P2_NORMAL ? c.p2DeadlineMs
      : c.p3DeadlineMs;
    return admittedAtMs + d;
  }

  /**
   * Admit a candidate for evaluation. Never throws for scheduling reasons - every
   * rejection is an explicit terminal state (NOT_ELIGIBLE / EVICTED), never a silent
   * drop. Concurrent admissions for the same symbol+fingerprint coalesce onto the one
   * tracked evaluation (deduped: true).
   */
  admit(candidate: QuantSchedulerCandidate): AdmissionResult {
    const nowMs = this.now();
    const symbol = (candidate.symbol ?? '').trim().toUpperCase();

    if (this.stopped || !this.started) {
      return this.immediateTerminal(symbol || 'UNKNOWN', candidate, 'NOT_ELIGIBLE', 'SCHEDULER_NOT_RUNNING', nowMs);
    }
    if (!symbol || !/^[A-Z0-9.\-^]+$/.test(symbol)) {
      return this.immediateTerminal(symbol || 'UNKNOWN', candidate, 'NOT_ELIGIBLE', 'INVALID_SYMBOL', nowMs);
    }

    const fingerprint = this.defaultFingerprint({ ...candidate, symbol });
    const key = this.dedupKey(symbol, fingerprint);

    // 1. Coalesce onto an in-flight scheduler evaluation.
    const inflightRec = this.inflight.get(key);
    if (inflightRec && !inflightRec.terminalState) {
      this.metrics.deduped += 1;
      return { accepted: true, candidateId: inflightRec.candidateId, deduped: true, outcome: inflightRec.outcomePromise };
    }
    // 2. Coalesce onto a recently-terminal outcome (dedup window).
    const recent = this.recentTerminal.get(key);
    if (recent && nowMs - recent.terminalAtMs <= this.config.dedupWindowMs) {
      this.metrics.deduped += 1;
      return { accepted: true, candidateId: recent.outcome.candidateId, deduped: true, outcome: Promise.resolve(recent.outcome) };
    }
    if (recent) this.recentTerminal.delete(key);

    // 3. Coordinate with an external (fast-lane) in-flight evaluation: do not duplicate
    //    it. The external system owns that evaluation's lifecycle; the scheduler simply
    //    refuses to run a second one. The caller can await the external promise itself.
    const external = this.externalInflight.get(key);
    if (external) {
      this.metrics.deduped += 1;
      return { accepted: false, candidateId: null, deduped: true, externalInFlight: true, outcome: external.promise };
    }

    // 4. Queue-depth bound with priority preemption.
    if (this.tracked.size >= this.config.maxQueueDepth) {
      const priority = candidate.priority;
      // Evict the most-evictable tracked candidate strictly below the newcomer's
      // priority. Rank: lower priority first, then parked-before-inflight (evicting
      // an in-flight candidate wastes its partial work without freeing its slot
      // promptly - a parked candidate never started), then oldest. A P0 must be able
      // to displace a P3, but never equal-or-higher-priority work.
      const evictRank = (rec: TrackedCandidate): number => {
        const fetching =
          rec.stages.dataFetchStartedAtMs != null && rec.stages.dataFetchFinishedAtMs == null;
        const evaluating =
          rec.stages.quantStartedAtMs != null && rec.stages.quantFinishedAtMs == null;
        const parkedBonus = !fetching && !evaluating ? 1_000_000 : 0;
        return rec.priority * 10_000_000 + parkedBonus - rec.admittedAtMs / 1_000_000_000;
      };
      let victim: TrackedCandidate | null = null;
      let bestRank = -Infinity;
      for (const rec of this.tracked.values()) {
        if (rec.terminalState) continue;
        if (rec.priority <= priority) continue;
        const rank = evictRank(rec);
        if (rank > bestRank) {
          bestRank = rank;
          victim = rec;
        }
      }
      if (victim) {
        this.setTerminal(victim, 'EVICTED', 'PREEMPTED_BY_HIGHER_PRIORITY');
      } else {
        // Queue is full of equal-or-higher-priority work: the newcomer is the evicted one.
        return this.immediateTerminal(symbol, candidate, 'EVICTED', 'QUEUE_FULL', nowMs);
      }
    }

    const candidateId = generateTraceId(`sched-${symbol}`);
    const priority = candidate.priority;
    const admittedAtMs = nowMs;
    let resolveOutcome!: (o: CandidateOutcome) => void;
    const outcomePromise = new Promise<CandidateOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const rec: TrackedCandidate = {
      candidateId,
      symbol,
      priority,
      priorityClass: priorityClassOf(priority),
      source: candidate.source,
      fingerprint,
      admittedAtMs,
      queuedAtMs: admittedAtMs,
      deadlineMs: this.deadlineFor(priority, admittedAtMs),
      expiresAtMs: candidate.expiresAtMs ?? null,
      emitIdeas: candidate.emitIdeas !== false,
      cycleCtx: candidate.cycleCtx,
      stages: {
        admittedAtMs,
        queuedAtMs: admittedAtMs,
        dataReadinessCheckedAtMs: null,
        dataFetchStartedAtMs: null,
        dataFetchFinishedAtMs: null,
        quantStartedAtMs: null,
        javaStartedAtMs: null,
        javaFinishedAtMs: null,
        quantFinishedAtMs: null,
        terminalAtMs: null,
      },
      terminalState: null,
      reasonCode: null,
      deduped: false,
      evaluationSettledLate: false,
      quantQuarantinedAtMs: null,
      resolveOutcome,
      outcomePromise,
      deadlineExceededWhileInFlight: false,
    };
    this.tracked.set(candidateId, rec);
    this.inflight.set(key, rec);
    this.metrics.admitted += 1;
    this.emit('QUANT_SCHEDULER_CANDIDATE_ADMITTED', {
      candidateId, symbol, priority, priorityClass: rec.priorityClass, source: rec.source,
      fingerprint, admittedAtMs, deadlineMs: rec.deadlineMs, expiresAtMs: rec.expiresAtMs,
    });
    // The candidate's async pipeline runs on its own; the outcome promise is the handle.
    void this.processCandidate(rec);
    return { accepted: true, candidateId, deduped: false, outcome: outcomePromise };
  }

  /**
   * Coordination point for the Fast Lane (fastLaneEvaluator.ts keeps its own
   * inFlightBySymbol dedup - this module never touches it). While registered, the
   * scheduler will not start a duplicate evaluation for the same symbol+fingerprint;
   * admissions coalesce (deduped: true). Returns an unregister function the external
   * system calls when its evaluation settles; the optional outcome is remembered for
   * the dedup window so immediate re-admission does not re-evaluate.
   */
  registerExternalEvaluation(
    symbol: string,
    fingerprint: string,
    done: Promise<unknown>,
    outcome?: CandidateOutcome,
  ): () => void {
    const key = this.dedupKey(symbol, fingerprint);
    this.externalInflight.set(key, { promise: done, registeredAtMs: this.now() });
    let unregistered = false;
    return () => {
      if (unregistered) return;
      unregistered = true;
      this.externalInflight.delete(key);
      if (outcome) {
        this.recentTerminal.set(key, { outcome, terminalAtMs: this.now() });
      }
    };
  }

  /** Immediate terminal at admit time (NOT_ELIGIBLE / EVICTED): emitted, never silent. */
  private immediateTerminal(
    symbol: string,
    candidate: QuantSchedulerCandidate,
    terminalState: 'NOT_ELIGIBLE' | 'EVICTED',
    reasonCode: string,
    nowMs: number,
  ): AdmissionResult {
    const candidateId = generateTraceId(`sched-${symbol}`);
    const priority = candidate.priority;
    const outcome: CandidateOutcome = {
      candidateId,
      symbol,
      priority,
      priorityClass: priorityClassOf(priority),
      source: candidate.source,
      terminalState,
      reasonCode,
      stages: {
        admittedAtMs: nowMs,
        queuedAtMs: nowMs,
        dataReadinessCheckedAtMs: null,
        dataFetchStartedAtMs: null,
        dataFetchFinishedAtMs: null,
        quantStartedAtMs: null,
        javaStartedAtMs: null,
        javaFinishedAtMs: null,
        quantFinishedAtMs: null,
        terminalAtMs: nowMs,
      },
      admissionToQuantStartMs: null,
      admissionToTerminalMs: 0,
      deduped: false,
      evaluationSettledLate: false,
    };
    this.metrics.admitted += 1;
    this.metrics.terminalByState[terminalState] = (this.metrics.terminalByState[terminalState] ?? 0) + 1;
    this.emit('QUANT_SCHEDULER_CANDIDATE_TERMINAL', this.terminalFields(outcome));
    return { accepted: false, candidateId, deduped: false, terminalState, reasonCode, outcome: Promise.resolve(outcome) };
  }

  private terminalFields(o: CandidateOutcome): Record<string, unknown> {
    return {
      candidateId: o.candidateId,
      symbol: o.symbol,
      priority: o.priority,
      priorityClass: o.priorityClass,
      source: o.source,
      terminalState: o.terminalState,
      reasonCode: o.reasonCode,
      admittedAtMs: o.stages.admittedAtMs,
      queuedAtMs: o.stages.queuedAtMs,
      dataReadinessCheckedAtMs: o.stages.dataReadinessCheckedAtMs,
      dataFetchStartedAtMs: o.stages.dataFetchStartedAtMs,
      dataFetchFinishedAtMs: o.stages.dataFetchFinishedAtMs,
      quantStartedAtMs: o.stages.quantStartedAtMs,
      javaStartedAtMs: o.stages.javaStartedAtMs,
      javaFinishedAtMs: o.stages.javaFinishedAtMs,
      quantFinishedAtMs: o.stages.quantFinishedAtMs,
      terminalAtMs: o.stages.terminalAtMs,
      admissionToQuantStartMs: o.admissionToQuantStartMs,
      admissionToTerminalMs: o.admissionToTerminalMs,
      deduped: o.deduped,
      evaluationSettledLate: o.evaluationSettledLate,
    };
  }

  /** Exactly-once terminal transition. Emits the terminal observability event carrying
   *  every stage timestamp, resolves the outcome promise, and records the outcome for
   *  the dedup window. Returns false if the candidate was already terminal. */
  private setTerminal(rec: TrackedCandidate, state: QuantTerminalState, reasonCode: string): boolean {
    if (rec.terminalState) return false;
    const nowMs = this.now();
    rec.terminalState = state;
    rec.reasonCode = reasonCode;
    rec.stages.terminalAtMs = nowMs;
    this.tracked.delete(rec.candidateId);
    this.inflight.delete(this.dedupKey(rec.symbol, rec.fingerprint));
    const outcome: CandidateOutcome = {
      candidateId: rec.candidateId,
      symbol: rec.symbol,
      priority: rec.priority,
      priorityClass: rec.priorityClass,
      source: rec.source,
      terminalState: state,
      reasonCode,
      stages: { ...rec.stages },
      admissionToQuantStartMs:
        rec.stages.quantStartedAtMs != null ? rec.stages.quantStartedAtMs - rec.stages.admittedAtMs : null,
      admissionToTerminalMs: nowMs - rec.stages.admittedAtMs,
      deduped: rec.deduped,
      evaluationSettledLate: rec.evaluationSettledLate,
    };
    this.recentTerminal.set(this.dedupKey(rec.symbol, rec.fingerprint), { outcome, terminalAtMs: nowMs });
    this.metrics.terminalByState[state] = (this.metrics.terminalByState[state] ?? 0) + 1;
    this.emit('QUANT_SCHEDULER_CANDIDATE_TERMINAL', this.terminalFields(outcome));
    rec.resolveOutcome(outcome);
    return true;
  }

  /** Deadline/expiry sweeper. Queued candidates past expiresAt -> EXPIRED; past the
   *  per-priority assessment deadline -> ASSESSMENT_EXPIRED. In-flight candidates past
   *  deadline are flagged; their settle path records ASSESSMENT_EXPIRED (the late
   *  result is never presented as current). Quarantined quant evaluations older than
   *  quantQuarantineMaxAgeMs are evicted (dedup entry released - hung work must not
   *  pin a symbol forever). External registrations older than
   *  externalRegistrationMaxAgeMs are evicted (a crashed external system must not
   *  block a symbol forever). Also evicts stale dedup-window entries. */
  private sweep(): void {
    const nowMs = this.now();
    for (const rec of [...this.tracked.values()]) {
      if (rec.terminalState) continue;
      // Quarantine-age bound: a watchdog-timed-out quant evaluation that never
      // settled must not hold its dedup key forever. Evict terminally; if the
      // orphan later settles, its discard path is a harmless no-op (exactly-once).
      if (
        rec.quantQuarantinedAtMs != null &&
        nowMs - rec.quantQuarantinedAtMs > this.config.quantQuarantineMaxAgeMs
      ) {
        this.setTerminal(rec, 'ASSESSMENT_EXPIRED', 'QUANT_QUARANTINE_AGE_EXCEEDED');
        continue;
      }
      // "In flight" means actively holding a slot RIGHT NOW - fetching (fetch started,
      // not finished) or evaluating (quant started, not finished). A candidate parked
      // between stages (data fetch done, waiting for a quant slot) or waiting for any
      // slot is QUEUED: its deadline applies in full. The previous version treated
      // "ever started the data stage" as in-flight, which wrongly shielded parked
      // candidates from their deadline.
      const fetching =
        rec.stages.dataFetchStartedAtMs != null && rec.stages.dataFetchFinishedAtMs == null;
      const evaluating =
        rec.stages.quantStartedAtMs != null && rec.stages.quantFinishedAtMs == null;
      const inFlight = fetching || evaluating;
      if (rec.expiresAtMs != null && nowMs > rec.expiresAtMs && !inFlight) {
        this.setTerminal(rec, 'EXPIRED', 'CANDIDATE_TTL_EXCEEDED');
        continue;
      }
      if (nowMs > rec.deadlineMs) {
        if (inFlight) {
          rec.deadlineExceededWhileInFlight = true;
        } else {
          this.setTerminal(rec, 'ASSESSMENT_EXPIRED', 'PRIORITY_DEADLINE_EXCEEDED_WHILE_QUEUED');
        }
      }
    }
    for (const [key, entry] of [...this.recentTerminal.entries()]) {
      if (nowMs - entry.terminalAtMs > this.config.dedupWindowMs) this.recentTerminal.delete(key);
    }
    for (const [key, entry] of [...this.externalInflight.entries()]) {
      if (nowMs - entry.registeredAtMs > this.config.externalRegistrationMaxAgeMs) {
        this.externalInflight.delete(key);
        this.emit('QUANT_SCHEDULER_EXTERNAL_REGISTRATION_EVICTED', {
          dedupKey: key,
          ageMs: nowMs - entry.registeredAtMs,
          maxAgeMs: this.config.externalRegistrationMaxAgeMs,
        });
      }
    }
  }

  /**
   * Data-readiness check: cheap cache read only, never a provider call. Mirrors the
   * gateway's own sufficiency contract EXACTLY (count floor OR coverage ratio, plus
   * tail freshness for present-time requests) so the scheduler's routing agrees with
   * what ensureBars() would conclude - the gateway remains the authoritative
   * enforcer at evaluation time. Historical windows (endMs clearly before now) are
   * exempt from tail freshness, exactly like the gateway's own check. The tail
   * tolerance is read from the gateway's own knob (quantBarsTailFreshnessToleranceMs)
   * rather than a second scheduler-local value: two knobs for the same freshness
   * definition would let routing and enforcement silently diverge.
   */
  private async checkDataReadiness(rec: TrackedCandidate): Promise<{
    sufficient: boolean;
    reasonCode: string;
    barCount: number;
    tailTimestampMs: number | null;
  }> {
    const nowMs = this.now();
    const endMs = nowMs;
    const startMs = endMs - this.deps.lookbackDays * 24 * 60 * 60 * 1000;
    rec.stages.dataReadinessCheckedAtMs = nowMs;
    const bars = await this.deps.getBars(rec.symbol, this.timeframe, startMs, endMs);
    const barCount = bars.length;
    const tailTimestampMs = barCount > 0 ? bars[barCount - 1].timestamp : null;
    // Gateway contract (HistoricalDataGateway.ensureBarsInner): sufficient when
    // existing.length >= regimeMinBars OR coverage >= quantBarsCacheMinCoverageRatio.
    // deps.minBars IS regimeMinBars (QuantSignalAgent wires MIN_BARS_TO_EVALUATE, which
    // is MIN_BARS = tradingSafety.regimeMinBars).
    const expected = this.deps.expectedBarCount
      ? this.deps.expectedBarCount(this.timeframe, startMs, endMs)
      : this.deps.minBars;
    const coverage = expected > 0 ? barCount / expected : 0;
    const countSufficient =
      barCount >= this.deps.minBars || coverage >= tradingSafety.quantBarsCacheMinCoverageRatio;
    if (!countSufficient) {
      return { sufficient: false, reasonCode: 'INSUFFICIENT_BAR_COUNT', barCount, tailTimestampMs };
    }
    const tailToleranceMs = tradingSafety.quantBarsTailFreshnessToleranceMs;
    const isPresentTime = endMs >= nowMs - tailToleranceMs;
    if (isPresentTime && tailTimestampMs != null && tailTimestampMs < nowMs - tailToleranceMs) {
      return { sufficient: false, reasonCode: 'STALE_TAIL', barCount, tailTimestampMs };
    }
    return { sufficient: true, reasonCode: 'SUFFICIENT', barCount, tailTimestampMs };
  }

  /**
   * The per-candidate pipeline. Never throws for scheduling reasons: any unexpected
   * failure (a deps call throwing outside its handled paths, an observability sink
   * throwing) terminally transitions the candidate to ERROR instead of leaving it
   * stuck with an unhandled rejection and a never-resolving outcome promise.
   * setTerminal is exactly-once, so this guard cannot double-terminalize.
   */
  private async processCandidate(rec: TrackedCandidate): Promise<void> {
    try {
      await this.processCandidateInner(rec);
    } catch (e) {
      this.setTerminal(
        rec,
        'ERROR',
        `SCHEDULER_PIPELINE_FAILED:${String((e as Error)?.message ?? e).slice(0, 120)}`,
      );
    }
  }

  /** The per-candidate pipeline. Data acquisition holds ONLY a data-fetch slot;
   *  computation holds ONLY a quant slot - never the same slot across both. */
  private async processCandidateInner(rec: TrackedCandidate): Promise<void> {
    // ---- DATA ACQUISITION STAGE (bounded data-fetch pool, no quant slot held) ----
    const fetchRelease = await this.fetchSem.acquire(rec.priority);
    try {
      if (rec.terminalState) return;
      // The gateway's reactive 429 backoff is authoritative: while armed, this
      // candidate resolves honestly instead of queueing behind a known-bad provider.
      if (this.deps.providerRateLimitedUntilMs() > this.now()) {
        this.setTerminal(rec, 'PROVIDER_BACKOFF', 'GATEWAY_RATE_LIMIT_BACKOFF_ARMED');
        return;
      }
      rec.stages.dataFetchStartedAtMs = this.now();
      this.emit('QUANT_SCHEDULER_DATA_FETCH_STARTED', {
        candidateId: rec.candidateId, symbol: rec.symbol, priority: rec.priority,
      });
      const fetchOutcome = await this.runDataFetch(rec);
      rec.stages.dataFetchFinishedAtMs = this.now();
      this.emit('QUANT_SCHEDULER_DATA_FETCH_FINISHED', {
        candidateId: rec.candidateId, symbol: rec.symbol, priority: rec.priority,
        durationMs: rec.stages.dataFetchFinishedAtMs - (rec.stages.dataFetchStartedAtMs ?? rec.stages.dataFetchFinishedAtMs),
        outcome: fetchOutcome,
      });
      if (fetchOutcome === 'TERMINAL_SET') return; // runDataFetch already transitioned
      if (fetchOutcome === 'STILL_INSUFFICIENT') {
        this.setTerminal(rec, 'DATA_UNAVAILABLE', 'DATA_STILL_INSUFFICIENT_AFTER_FETCH');
        return;
      }
    } finally {
      fetchRelease();
    }
    if (rec.terminalState) return;

    // ---- COMPUTATION STAGE (bounded quant pool, priority-ordered handoff) ----
    const quantRelease = await this.quantSem.acquire(rec.priority);
    try {
      if (rec.terminalState) return;
      rec.stages.quantStartedAtMs = this.now();
      this.emit('QUANT_SCHEDULER_QUANT_STARTED', {
        candidateId: rec.candidateId, symbol: rec.symbol, priority: rec.priority,
        queueWaitMs: (rec.stages.quantStartedAtMs ?? 0) - rec.stages.admittedAtMs,
      });
      const quantOutcome = await this.runQuantStageWithWatchdog(rec);
      // Quarantined: the watchdog fired, the quant slot was already returned to the
      // pool, and the candidate stays tracked until its late settle is discarded or
      // the sweeper evicts the quarantine by age. Nothing further to do here.
      if (quantOutcome.quarantined) return;
      if (rec.terminalState) return;
      rec.stages.quantFinishedAtMs = this.now();
      const quantDurationMs =
        rec.stages.quantFinishedAtMs - (rec.stages.quantStartedAtMs ?? rec.stages.quantFinishedAtMs);
      const settledOutcome = quantOutcome as { quarantined: false; evaluation: unknown; threw: unknown };
      const { evaluation, threw } = settledOutcome;
      if (threw) {
        const msg = String((threw as Error)?.message ?? threw);
        if (RATE_LIMIT_WORDING.test(msg)) {
          this.emit('QUANT_SCHEDULER_QUANT_FINISHED', {
            candidateId: rec.candidateId, symbol: rec.symbol, durationMs: quantDurationMs,
            evaluationOutcome: 'RATE_LIMITED',
          });
          this.setTerminal(rec, 'PROVIDER_BACKOFF', 'EVALUATION_RATE_LIMITED');
        } else {
          this.emit('QUANT_SCHEDULER_QUANT_FINISHED', {
            candidateId: rec.candidateId, symbol: rec.symbol, durationMs: quantDurationMs,
            evaluationOutcome: 'ERROR',
          });
          this.setTerminal(rec, 'ERROR', `EVALUATION_THREW:${msg.slice(0, 120)}`);
        }
        return;
      }
      this.emit('QUANT_SCHEDULER_QUANT_FINISHED', {
        candidateId: rec.candidateId, symbol: rec.symbol, durationMs: quantDurationMs,
        evaluationOutcome: evaluation != null ? 'ASSESSED' : 'INSUFFICIENT_BARS',
      });
      // A deadline that passed while the evaluation was in flight: the result arrived
      // too late to be current. Recorded honestly, never presented as fresh.
      if (rec.deadlineExceededWhileInFlight || this.now() > rec.deadlineMs) {
        rec.evaluationSettledLate = true;
        this.setTerminal(rec, 'ASSESSMENT_EXPIRED', 'EVALUATION_SETTLED_AFTER_DEADLINE');
        return;
      }
      if (evaluation != null) {
        this.setTerminal(rec, 'ASSESSED', 'EVALUATION_RETURNED');
      } else {
        // evaluateSymbol's only null return is its INSUFFICIENT_BARS early return.
        this.setTerminal(rec, 'DATA_UNAVAILABLE', 'INSUFFICIENT_BARS_AT_EVALUATION');
      }
    } finally {
      quantRelease();
    }
  }

  /**
   * Runs the quant evaluation under a liveness watchdog. evaluateSymbol() has no safe
   * cancellation, so a hung evaluation would otherwise hold its quant slot forever and
   * pool-size hangs would wedge quant throughput permanently (queued candidates would
   * still expire via the deadline sweeper, but no new work would run).
   *
   * On watchdog expiry the candidate is QUARANTINED: the caller releases the quant
   * slot via its normal finally (capacity recovers immediately) while the inflight
   * dedup entry is KEPT, so no duplicate evaluation can start for the same
   * symbol+fingerprint. The candidate stays tracked; when the orphaned evaluation
   * eventually settles its result is discarded (never presented as current) and the
   * candidate terminally transitions to ASSESSMENT_EXPIRED. If the orphan never
   * settles, the sweeper evicts the quarantine after quantQuarantineMaxAgeMs and
   * releases the dedup entry. This mirrors the fast-lane hung-lease quarantine
   * (27e17d3): capacity recovery without reintroducing invisible concurrency for
   * duplicate work.
   */
  private async runQuantStageWithWatchdog(
    rec: TrackedCandidate,
  ): Promise<QuantStageOutcome> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<'quant-timeout'>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve('quant-timeout');
        }, this.config.quantEvaluationTimeoutMs);
      });
      // then-wrapped so the orphan never rejects unobserved after quarantine.
      const evalPromise = this.deps.evaluateSymbol(rec.symbol, {
        emitIdeas: rec.emitIdeas,
        ...(rec.cycleCtx ? { cycleCtx: rec.cycleCtx } : {}),
      }).then(
        (value) => ({ value }) as const,
        (error: unknown) => ({ error }) as const,
      );
      const result = await Promise.race([evalPromise, timeoutPromise]);
      if (timedOut || result === 'quant-timeout') {
        rec.quantQuarantinedAtMs = this.now();
        this.emit('QUANT_SCHEDULER_QUANT_QUARANTINED', {
          candidateId: rec.candidateId,
          symbol: rec.symbol,
          priority: rec.priority,
          timeoutMs: this.config.quantEvaluationTimeoutMs,
          quarantinedAtMs: rec.quantQuarantinedAtMs,
        });
        // Discard the late settle deterministically. setTerminal is exactly-once: if
        // the sweeper already evicted the quarantine by age, this is a harmless no-op.
        void evalPromise.then((settled) => {
          rec.evaluationSettledLate = true;
          this.emit('QUANT_SCHEDULER_QUANT_LATE_SETTLE_DISCARDED', {
            candidateId: rec.candidateId,
            symbol: rec.symbol,
            settled: 'error' in settled ? 'threw' : 'resolved',
          });
          this.setTerminal(rec, 'ASSESSMENT_EXPIRED', 'QUANT_EVALUATION_TIMED_OUT_LATE_SETTLE');
        });
        return { quarantined: true };
      }
      const settled = result as { value: unknown } | { error: unknown };
      if ('error' in settled) return { quarantined: false, evaluation: null, threw: settled.error };
      return { quarantined: false, evaluation: settled.value, threw: null };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Runs the data-fetch leg for one candidate. Returns 'SUFFICIENT' when the cache now
   * passes the readiness check, 'STILL_INSUFFICIENT' when a per-policy fetch did not,
   * or 'TERMINAL_SET' when this method already transitioned the candidate
   * (PROVIDER_TIMEOUT / PROVIDER_BACKOFF / ERROR).
   */
  private async runDataFetch(rec: TrackedCandidate): Promise<'SUFFICIENT' | 'STILL_INSUFFICIENT' | 'TERMINAL_SET'> {
    const nowMs = this.now();
    const endMs = nowMs;
    const startMs = endMs - this.deps.lookbackDays * 24 * 60 * 60 * 1000;
    let readiness: Awaited<ReturnType<QuantPriorityScheduler['checkDataReadiness']>>;
    try {
      readiness = await this.checkDataReadiness(rec);
    } catch (e) {
      // A failed cache READ is not a provider verdict - surface honestly, fail closed.
      this.setTerminal(rec, 'ERROR', `DATA_READINESS_CHECK_FAILED:${String((e as Error)?.message ?? e).slice(0, 120)}`);
      return 'TERMINAL_SET';
    }
    if (readiness.sufficient) return 'SUFFICIENT';

    // Missing/stale -> bounded provider fetch. The timeout race mirrors the fast-lane
    // D4 liveness watchdog: a hung fetch must never wedge the data-fetch pool. The
    // underlying promise is left to settle on its own (gateway coalescing cleans up);
    // its late result is discarded, never applied.
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve('timeout');
        }, this.config.dataFetchTimeoutMs);
      });
      const fetchPromise = this.deps.ensureBars(rec.symbol, this.timeframe, startMs, endMs).then(
        () => 'fetched' as const,
        (e: unknown) => ({ fetchError: e }) as const,
      );
      const result = await Promise.race([fetchPromise, timeoutPromise]);
      if (timedOut || result === 'timeout') {
        this.setTerminal(rec, 'PROVIDER_TIMEOUT', `DATA_FETCH_EXCEEDED_${this.config.dataFetchTimeoutMs}MS`);
        return 'TERMINAL_SET';
      }
      if (typeof result === 'object' && 'fetchError' in result) {
        const msg = String((result.fetchError as Error)?.message ?? result.fetchError);
        if (RATE_LIMIT_WORDING.test(msg)) {
          this.setTerminal(rec, 'PROVIDER_BACKOFF', 'DATA_FETCH_RATE_LIMITED');
          return 'TERMINAL_SET';
        }
        // Non-429 fetch failure: re-check the cache - a partial/racing write may still
        // have made the data sufficient. If not, this is an honest provider error.
        const recheck = await this.checkDataReadiness(rec);
        if (recheck.sufficient) return 'SUFFICIENT';
        this.setTerminal(rec, 'ERROR', `DATA_FETCH_FAILED:${msg.slice(0, 120)}`);
        return 'TERMINAL_SET';
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    // Fetch completed per policy - verify it actually moved the data, never relabel
    // stale rows as fresh (same honesty rule as the gateway's own stale-tail gate).
    const after = await this.checkDataReadiness(rec);
    return after.sufficient ? 'SUFFICIENT' : 'STILL_INSUFFICIENT';
  }
}

/** Lazily-initialized process singleton. initQuantPriorityScheduler() must be called
 *  before use (QuantSignalAgent.start() does this when the feature flag is on);
 *  admissions before init resolve NOT_ELIGIBLE, never throw. */
let singleton: QuantPriorityScheduler | null = null;

export function initQuantPriorityScheduler(deps: QuantSchedulerDeps): QuantPriorityScheduler {
  // A stopped singleton is fully retired (its tracked candidates were terminally EVICTED
  // by stop()); a fresh one is built so start()->stop()->start() cycles revive cleanly.
  if (singleton && singleton.isStopped()) {
    singleton = null;
  }
  if (singleton) return singleton;
  singleton = new QuantPriorityScheduler(deps);
  singleton.start();
  return singleton;
}

export function getQuantPriorityScheduler(): QuantPriorityScheduler | null {
  return singleton;
}

/** For tests: drop the singleton between suites. */
export function resetQuantPrioritySchedulerForTests(): void {
  if (singleton) {
    try {
      singleton.stop();
    } catch {
      /* never fail test teardown */
    }
  }
  singleton = null;
}

export function isSchedulerFeatureEnabled(): boolean {
  return isQuantPrioritySchedulerEnabled();
}

// ---------------------------------------------------------------------------
// runCycle batch integration (feature-flagged path in QuantSignalAgent.runCycle)
// ---------------------------------------------------------------------------

export interface SchedulerBatchOptions {
  cycleId: string;
  /** Priority assignment per symbol (movers -> P0, normal universe -> P2, ...). */
  priorityOf: (symbol: string, index: number) => QuantCandidatePriority;
  source?: string;
  emitIdeas?: boolean;
  fingerprintOf?: (symbol: string) => string;
}

export interface SchedulerBatchSummary {
  cycleId: string;
  admittedSymbols: string[];
  attemptedSymbols: string[];
  completedSymbols: string[];
  notAttemptedSymbols: string[];
  /** Symbols whose evaluation is owned by an external (fast-lane) in-flight evaluation
   *  the scheduler refused to duplicate. Not attempted by the scheduler, not dropped. */
  externallyDedupedSymbols: string[];
  terminalBySymbol: Map<string, CandidateOutcome>;
  terminalStateCounts: Record<string, number>;
  reason: 'COMPLETED' | 'BATCH_WAIT_EXCEEDED';
}

/**
 * Admits a cycle's universe to the scheduler and awaits every candidate's terminal
 * state, bounded by maxBatchWaitMs. Priority affects WHEN each symbol is evaluated,
 * never any gate outcome. Returns the batch summary runCycle uses for its
 * QUANT_CYCLE_COMPLETED event; symbols still without a terminal state after the wait
 * stay tracked by the scheduler (next cycle's re-admission dedups onto them).
 */
export async function runQuantSchedulerBatch(
  scheduler: QuantPriorityScheduler,
  symbols: string[],
  opts: SchedulerBatchOptions,
): Promise<SchedulerBatchSummary> {
  const source = opts.source ?? 'CYCLE';
  const outcomes = new Map<string, Promise<CandidateOutcome>>();
  const externalOutcomes = new Map<string, Promise<unknown>>();
  const admittedSymbols: string[] = [];
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    const admission = scheduler.admit({
      symbol,
      priority: opts.priorityOf(symbol, i),
      source,
      evaluationFingerprint: opts.fingerprintOf?.(symbol),
      emitIdeas: opts.emitIdeas,
      cycleCtx: { cycleId: opts.cycleId, scheduledIndex: i },
    });
    // NOT_ELIGIBLE/EVICTED-at-admit still resolve to an explicit terminal outcome.
    admittedSymbols.push(symbol);
    // The externalInFlight variant is the only one carrying that marker property;
    // `in`-narrowing separates it reliably from the two scheduler-owned variants.
    if (!('externalInFlight' in admission)) {
      outcomes.set(symbol, admission.outcome);
    } else {
      // External (fast-lane) in-flight: the scheduler will not duplicate it. Awaited
      // within the same bounded wait so the batch does not report before the external
      // evaluation settles, but never mapped to a scheduler terminal state - the
      // external system owns that evaluation's lifecycle and vocabulary.
      externalOutcomes.set(symbol, admission.outcome);
    }
  }

  const config = scheduler.getConfig();
  let waitExceeded = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const allSettled = Promise.all([
      ...[...outcomes.values()].map((p) => p.then(
        () => 'settled' as const,
        () => 'settled' as const,
      )),
      ...[...externalOutcomes.values()].map((p) => p.then(
        () => 'settled' as const,
        () => 'settled' as const,
      )),
    ]);
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), config.maxBatchWaitMs);
    });
    const winner = await Promise.race([allSettled.then(() => 'done' as const), timeout]);
    waitExceeded = winner === 'timeout';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  const terminalBySymbol = new Map<string, CandidateOutcome>();
  const attemptedSymbols: string[] = [];
  const completedSymbols: string[] = [];
  const notAttemptedSymbols: string[] = [];
  const externallyDedupedSymbols: string[] = [];
  const terminalStateCounts: Record<string, number> = {};
  if (!waitExceeded) {
    // Every outcome promise settled (Promise.all above resolved) - collect directly.
    for (const [symbol, outcomePromise] of outcomes) {
      const o = await outcomePromise;
      terminalBySymbol.set(symbol, o);
      attemptedSymbols.push(symbol);
      terminalStateCounts[o.terminalState] = (terminalStateCounts[o.terminalState] ?? 0) + 1;
      if (o.terminalState === 'ASSESSED') completedSymbols.push(symbol);
    }
    for (const symbol of externalOutcomes.keys()) externallyDedupedSymbols.push(symbol);
  } else {
    // Bounded wait expired: record what settled without awaiting the rest. A settled
    // promise's .then callback runs on the microtask queue, so one flush per symbol is
    // enough to observe it; unsettled promises stay null and are reported honestly.
    for (const [symbol, outcomePromise] of outcomes) {
      let settled: CandidateOutcome | null = null;
      // Outcome promises only ever resolve (setTerminal), but never leave a rejection
      // unhandled if that invariant ever breaks.
      void outcomePromise.then(
        (o) => {
          settled = o;
        },
        () => {
          settled = null;
        },
      );
      await Promise.resolve();
      if (settled) {
        const o = settled as CandidateOutcome;
        terminalBySymbol.set(symbol, o);
        attemptedSymbols.push(symbol);
        terminalStateCounts[o.terminalState] = (terminalStateCounts[o.terminalState] ?? 0) + 1;
        if (o.terminalState === 'ASSESSED') completedSymbols.push(symbol);
      } else {
        notAttemptedSymbols.push(symbol);
      }
    }
    // External evaluations that settled within the wait are honestly reported as
    // externally owned (not scheduler-attempted, not dropped); unsettled ones stay
    // tracked by the external system.
    for (const [symbol, extPromise] of externalOutcomes) {
      let settled = false;
      void extPromise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.resolve();
      if (settled) externallyDedupedSymbols.push(symbol);
      else notAttemptedSymbols.push(symbol);
    }
  }

  return {
    cycleId: opts.cycleId,
    admittedSymbols,
    attemptedSymbols,
    completedSymbols,
    notAttemptedSymbols,
    externallyDedupedSymbols,
    terminalBySymbol,
    terminalStateCounts,
    reason: waitExceeded ? 'BATCH_WAIT_EXCEEDED' : 'COMPLETED',
  };
}
