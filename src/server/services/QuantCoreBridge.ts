/**
 * TypeScript-side client for the local, advisory-only Java Quant Core process
 * (docs/architecture/ARGUS_ARCHITECTURE.md (Java Quant Core section), Phases 2-3).
 *
 * Governance (do not weaken):
 * - Everything here is gated by tradingSafety.quantJavaCoreEnabledEnvVar (QUANT_JAVA_CORE_ENABLED,
 *   default false). Disabled = zero subscription, zero network calls, zero-op.
 * - Fire-and-forget only: forwarding a tick to Java is never awaited by the live tick handler
 *   and every call has a hard timeout (tradingSafety.quantJavaCoreRequestTimeoutMs) plus a
 *   circuit breaker, so a slow/down/crashed Java process can never add latency or throw inside
 *   MARKET_DATA handling. Fail-closed: on any error this bridge does less, never fabricates data.
 * - Phase 2 (shadow): forwards ticks, and periodically compares Java's computed indicators
 *   against the same real TS indicator functions (ParityComparator.ts), logging divergence only.
 *   Never calls emitTradeIdea in this mode.
 * - Phase 3 (gated live emission) requires a SECOND, separate flag
 *   (QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED, also default false) on top of the base flag above -
 *   turning on the bridge does not, by itself, turn on idea emission. This intentionally does
 *   not collapse the phase boundary the migration blueprint describes (a real shadow soak period
 *   before any live emission is considered).
 * - onSignal() re-validates the ticker and clamps confidence itself, in addition to whatever
 *   eventBus.emitTradeIdea()'s own gateTradeIdea() already enforces - defense in depth at a new
 *   external-process boundary, matching this codebase's existing "trust nothing from an external
 *   process" posture for AI provider output (AIOutputValidator.ts).
 * - Never imports RiskEngine, OrderManagementService, or BrokerManager. Never calls placeOrder.
 */
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { generateTraceId } from '../core/traceId';
import { looksLikeListedTicker } from '../ai/AIOutputValidator';
import { tradingSafety, isQuantJavaCoreEnabled } from '../config/tradingSafety';
import { RSIEngine } from '../engines/RSIEngine';
import { MACDEngine } from '../engines/MACDEngine';
import { calcBollingerBands } from './technicalSignal';
import { compareSnapshots, ComparableIndicatorSnapshot, compareRegimeSnapshots, ComparableRegimeSnapshot } from './ParityComparator';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';
import type { ResearchBar } from '../research/ohlcvTypes';
import type { RegimeResult } from '../quant/RegimeEngine';

const QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED_ENV_VAR = 'QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED';
const MIN_HISTORY_FOR_PARITY = 26; // matches SymbolState.java's MIN_HISTORY_FOR_INDICATORS
const PARITY_COMPARE_INTERVAL_MS = 60_000; // per-symbol debounce - never compares every tick
/** Periodic safety-net resync (docs/audits/ARGUS_JAVA_QUANT_AUTHORITY_ADR_2026-09-10.md §6) - the
 *  gap-triggered resync in onTick() handles the main case (a reported sequence mismatch), but this
 *  catches anything a gap report could in principle miss (e.g. a dropped response whose own
 *  gapDetected flag never made it back to this process). 30 min - not urgent given the reactive
 *  path is primary; this is deliberately infrequent, not a tight polling loop. */
const RESYNC_SAFETY_NET_INTERVAL_MS = 30 * 60_000;

/** Exported read-only for the /api/v2/quant-core/health route (Phase 3E dashboard) - callers must
 *  never use this to gate anything beyond display; onSignal() re-checks it itself regardless. */
export function isLiveIdeaEmissionEnabled(): boolean {
  return isQuantJavaCoreEnabled() && String(process.env[QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED_ENV_VAR] || '').toLowerCase() === 'true';
}

export interface InstitutionalVolatilityResult {
  schemaVersion: number;
  symbol: string;
  omega: number;
  alpha: number;
  beta: number;
  persistence: number;
  logLikelihood: number;
  unconditionalVariance: number;
  lastConditionalVariance: number;
  forecastStepsAhead: number;
  forecastVariance: number;
  forecastVolatility: number;
  returnsUsed: number;
  // Additive fields from VolatilityEngine.java (real percentile-rank against the symbol's own
  // trailing realized-vol history - see garchResultToJson's own comment in QuantCoreServer.java).
  realizedVolatility: number;
  realizedVolPercentile: number;
  volatilityCompressed: boolean;
  volatilityExpanded: boolean;
}

export interface InstitutionalRegimeResult {
  schemaVersion: number;
  symbol: string;
  currentRegime: 'BULL_TRENDING' | 'BEAR_TRENDING' | 'MEAN_REVERTING' | 'HIGH_VOL_CHAOS';
  logLikelihood: number;
  observationCount: number;
  stateLabels: string[];
  stateMeans: [number, number][];
  stateVariances: [number, number][];
  // Additive fields from VolatilityEngine.java (see hmmFittedToJson's own comment in QuantCoreServer.java).
  volatilityCompressed: boolean;
  volatilityExpanded: boolean;
  volatilityPercentile: number;
}

export interface InstitutionalFeaturesResult {
  schemaVersion: number;
  symbol: string;
  asOfMs: number;
  close: number;
  rsi: number;
  macd: number;
  macdSignal: number;
  bbUpper: number;
  bbLower: number;
  atr: number;
  realizedVolatility: number;
  barsUsed: number;
  qualityReport: {
    status: 'GREEN' | 'YELLOW' | 'RED';
    stale: boolean;
    sufficientHistory: boolean;
    anomalyDetected: boolean;
    gapDetected: boolean;
    issues: string[];
  };
}

export type EnsembleSide = 'BUY' | 'SELL' | 'NEUTRAL';

export interface EnsembleModelVote {
  modelId: string;
  family: string;
  side: EnsembleSide;
  confidence: number;
}

/** 2026-09-11 observability addition - see fetchInstitutionalEnsemble()'s own doc comment for the
 *  real investigation this closes. EMPTY_VOTES is logged by the CALLER (internalQuantEnsemble.ts),
 *  not here, since that early return happens before this function is ever invoked. */
export type EnsembleCallOutcome =
  | 'SUCCESS'
  | 'JAVA_DISABLED'
  | 'CIRCUIT_BREAKER_OPEN'
  | 'HTTP_ERROR'
  | 'NETWORK_ERROR_OR_TIMEOUT'
  | 'EMPTY_VOTES';

export interface InstitutionalEnsembleResult {
  schemaVersion: number;
  rawSide: EnsembleSide;
  totalVotes: number;
  agreeingCount: number;
  avgConfidenceOfAgreeing: number;
  effectiveIndependentCount: number;
  agreeingModelIds: string[];
  dissentingModelIds: string[];
}

export type HmmRegimeLabel = 'BULL_TRENDING' | 'BEAR_TRENDING' | 'MEAN_REVERTING' | 'HIGH_VOL_CHAOS';

export interface InstitutionalAdvisoryResult {
  schemaVersion: number;
  rawSide: EnsembleSide;
  rawAvgConfidence: number;
  rawEffectiveIndependentCount: number;
  regime: HmmRegimeLabel;
  regimeMultiplier: number;
  currentVolatility: number;
  volatilityMultiplier: number;
  adjustedConfidence: number;
  gated: boolean;
  reasoning: string;
  agreeingModelIds: string[];
  dissentingModelIds: string[];
}

export interface InstitutionalCorrelationResult {
  schemaVersion: number;
  symbols: string[];
  lambda: number;
  correlationMatrix: number[][];
}

export interface InstitutionalFactorsResult {
  schemaVersion: number;
  symbol: string;
  momentum: number;
  meanReversion: number;
  volumeLiquidity: number;
  volatility: number;
  orderFlowProxy: number;
  orderFlowProxyIsRealOrderFlow: false;
  composite: number;
}

/** Same {timestampMs, open, high, low, close, volume} shape QuantCoreServer.java's decodeBars() expects. */
function barsToJavaPayload(bars: ResearchBar[]): Array<{ timestampMs: number; open: number; high: number; low: number; close: number; volume: number }> {
  return bars.map((b) => ({ timestampMs: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
}

/** Mirrors QuantCoreServer.java's assessmentToJson() exactly (CoreStrategyRunner.Assessment). */
export interface CoreStrategyAssessment {
  schemaVersion: number;
  strategyId: string;
  strategyVersion: string;
  featureVersion: string;
  symbol: string;
  direction: 'BUY' | 'SELL' | 'DATA_UNAVAILABLE';
  score: number | null;
  confidence: number | null;
  reason: string;
  regime: string | null;
  dataQuality: 'FRESH' | 'STALE' | 'INSUFFICIENT_HISTORY';
  evaluationTimestampMs: number;
  latencyMs: number;
}

/** Mirrors QuantCoreServer.java's ensembleDecisionToJson() exactly (CoreStrategyRunner.EnsembleDecision). */
export interface CoreEnsembleDecision {
  schemaVersion: number;
  status: 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE';
  direction: 'BUY' | 'SELL' | 'HOLD';
  score: number;
  confidence: number;
  reason: string;
  regime: string | null;
  timestampMs: number;
  featureVersion: string;
  strategyVersion: string;
  strategyCount: number;
  agreeingCount: number;
  effectiveIndependentCount: number;
  contributingStrategies: string[];
  contributingFamilies: string[];
  assessments: CoreStrategyAssessment[];
}

interface RawJavaSignal {
  schemaVersion?: number;
  symbol?: unknown;
  side?: unknown;
  confidence?: unknown;
  strategyId?: unknown;
  reasoning?: unknown;
  currentPrice?: unknown;
}

class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt: number | null = null;

  isOpen(now: number = Date.now()): boolean {
    if (this.openedAt === null) return false;
    if (now - this.openedAt >= tradingSafety.quantJavaCoreCircuitBreakerCooldownMs) {
      this.openedAt = null;
      this.consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  recordFailure(now: number = Date.now()): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= tradingSafety.quantJavaCoreCircuitBreakerFailureThreshold) {
      this.openedAt = now;
    }
  }

  /** 2026-09-11 observability addition (P0 breaker-source trace) - read-only state accessors so
   *  every caller can log exactly what the shared breaker looked like immediately before/after its
   *  own recordFailure()/recordSuccess() call, without changing the breaker's own decision logic. */
  getFailureCount(): number {
    return this.consecutiveFailures;
  }

  getOpenedAt(): number | null {
    return this.openedAt;
  }
}

export class QuantCoreBridgeService {
  private listening = false;
  private readonly priceHistory: Record<string, number[]> = {};
  /** Added 2026-09-10 alongside sequence numbering (see onTick/resyncSymbol below) - needed so a
   *  resync can wholesale-replace Java's volumes CircularDoubleArray too, not just prices, leaving
   *  no stale/empty buffer behind for SymbolState's windowed VWAP. */
  private readonly volumeHistory: Record<string, number[]> = {};
  /** Monotonic per-symbol counter, assigned here (the TS-side sender of record for this protocol),
   *  not threaded back to MarketDataWorker.emitMarketData() - changing that shared EventBus payload
   *  would touch every MARKET_DATA subscriber for a protocol only this bridge needs. Starts at 0 for
   *  a never-before-seen symbol. docs/audits/ARGUS_JAVA_QUANT_AUTHORITY_ADR_2026-09-10.md §6. */
  private readonly sequenceBySymbol: Record<string, number> = {};
  private readonly lastParityCompareAt: Record<string, number> = {};
  private readonly lastResyncAt: Record<string, number> = {};
  /** Same PARITY_COMPARE_INTERVAL_MS throttle pattern as lastParityCompareAt above, kept in its
   *  own map (not shared with the tick-indicator comparison) so the two independent shadow checks
   *  never suppress one another's debounce window. */
  private readonly lastRegimeParityCompareAt: Record<string, number> = {};
  /**
   * 2026-09-11 circuit-breaker domain isolation (real, measured root cause - see the P0 breaker
   * forensic trace this session: institutional/strategy/volume_signal timeouts were found still
   * collaterally blocking healthy institutional/ensemble attempts even after the tick-concurrency
   * storm was fixed, because every institutional-* method shared ONE breaker instance). Split into
   * four domains so a failure in one never disables an unrelated healthy one:
   *   MARKET_TICK          - forwardTick/resyncSymbol (onTick, resyncSymbol) - by far the highest
   *                           call volume, the confirmed original storm source.
   *   QUANT_RESEARCH        - fetchResearchStrategy - the 10-way concurrent fan-out inside
   *                           computeInternalEnsembleQualification(), the confirmed residual
   *                           collateral-damage source after the tick fix.
   *   QUANT_ENSEMBLE         - fetchInstitutionalEnsemble/fetchInstitutionalAdvisory/
   *                           fetchCoreEnsembleDecision - the actual qualification decision calls
   *                           this whole investigation exists to keep available.
   *   INSTITUTIONAL_ANALYTICS - fetchInstitutionalVolatility/Factors/Features/Correlation/Regime/
   *                           fetchCoreStrategyAssessment - advisory-only context calls.
   * Same threshold/cooldown config for all four (quantJavaCoreCircuitBreakerFailureThreshold/
   * CooldownMs) - this is a scoping fix, not a sensitivity change.
   */
  private readonly tickBreaker = new CircuitBreaker();
  private readonly researchBreaker = new CircuitBreaker();
  private readonly ensembleBreaker = new CircuitBreaker();
  private readonly institutionalBreaker = new CircuitBreaker();

  /** Test-only. */
  getBreakerStatesForTests(): Record<'tick' | 'research' | 'ensemble' | 'institutional', { isOpen: boolean; failureCount: number }> {
    return {
      tick: { isOpen: this.tickBreaker.isOpen(), failureCount: this.tickBreaker.getFailureCount() },
      research: { isOpen: this.researchBreaker.isOpen(), failureCount: this.researchBreaker.getFailureCount() },
      ensemble: { isOpen: this.ensembleBreaker.isOpen(), failureCount: this.ensembleBreaker.getFailureCount() },
      institutional: { isOpen: this.institutionalBreaker.isOpen(), failureCount: this.institutionalBreaker.getFailureCount() },
    };
  }
  private readonly rsiEngine = new RSIEngine(14);
  private readonly macdEngine = new MACDEngine(12, 26, 9);
  /** Cached, non-blocking - refreshed by health(); read by the CLI/API route without a live network hop. */
  private lastKnownHealth: { connected: boolean; checkedAt: string; detail?: string } = {
    connected: false,
    checkedAt: new Date(0).toISOString(),
    detail: 'never checked',
  };

  /**
   * 2026-09-11 observability addition (P0 breaker-source trace - explicit operator request to
   * "add outcome telemetry to every QuantCoreBridge method... logged at the exact point where
   * recordFailure() happens" before touching the shared breaker's architecture). Purely additive:
   * every caller's return contract, timing, and control flow is byte-for-byte unchanged - this
   * only records what already happened. Distinguishes TIMEOUT (AbortSignal.timeout() firing)
   * from a genuine NETWORK_ERROR (connection refused, DNS, etc.) since the two point at very
   * different fixes (raise the budget vs. fix connectivity/concurrency).
   */
  private classifyFetchError(e: unknown): 'TIMEOUT' | 'NETWORK_ERROR' {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'TIMEOUT';
    return 'NETWORK_ERROR';
  }

  private logBridgeOutcome(params: {
    endpoint: string;
    symbol?: string;
    result: 'SUCCESS' | 'HTTP_ERROR' | 'TIMEOUT' | 'NETWORK_ERROR' | 'CIRCUIT_OPEN' | 'JAVA_DISABLED';
    httpStatus?: number;
    errorMessage?: string;
    durationMs?: number;
    breakerFailureCountBefore: number;
    breakerFailureCountAfter: number;
  }): void {
    observeSafe(() => {
      const parts = [`endpoint=${params.endpoint}`, `result=${params.result}`];
      if (params.httpStatus !== undefined) parts.push(`httpStatus=${params.httpStatus}`);
      if (params.errorMessage) parts.push(`error=${params.errorMessage.slice(0, 200)}`);
      if (params.durationMs !== undefined) parts.push(`durationMs=${params.durationMs}`);
      parts.push(`breakerFailuresBefore=${params.breakerFailureCountBefore}`);
      parts.push(`breakerFailuresAfter=${params.breakerFailureCountAfter}`);
      structuredLogger.info('quant_bridge_call_outcome', {
        category: 'OBSERVABILITY',
        eventType: 'QUANT_BRIDGE_CALL_OUTCOME',
        symbol: params.symbol,
        reasoning: parts.join(' '),
      });
    });
  }

  /**
   * 2026-09-11 concurrency/backpressure fix - real, measured root cause (see
   * quantJavaCoreTickMaxConcurrency's own doc comment in tradingSafety.ts for the full evidence):
   * forwardTick() previously fired one independent fetch() per MARKET_DATA tick with zero
   * concurrency limit, zero backpressure, and zero per-symbol deduplication. A burst of ticks
   * measured live at up to 3,326 simultaneous in-flight requests (vs. ~8 under normal load),
   * which starved the Node event loop badly enough that the 100ms request timeout was routinely
   * missed by 1-3+ seconds, tripping the shared CircuitBreaker almost continuously and
   * collaterally blocking every other institutional/quant endpoint sharing it.
   *
   * pendingTickBySymbol holds, per symbol, only the LATEST price/volume/timestamp not yet sent -
   * for live market data the newest state is what matters, not a backlog of stale intermediate
   * prints, so a newer tick for a symbol that already has one queued (or already has one in
   * flight) simply overwrites it rather than queuing a second request. activeTickSymbols +
   * inFlightTickCount enforce two ceilings: never more than one in-flight forwardTick per symbol
   * (preserves this bridge's own per-symbol ordering - sequence numbers are still assigned, and
   * sent, strictly in order for a given symbol), and never more than
   * quantJavaCoreTickMaxConcurrency in flight globally. A tick that gets coalesced away still has
   * its price/volume recorded via trackLocalHistory() immediately (see admitOrCoalesceTick) -
   * only the NETWORK dispatch is throttled, not this bridge's own in-memory bookkeeping.
   *
   * Coalescing intentionally causes forwardTick's sequence numbers to skip ahead for a
   * high-frequency symbol under load - that is exactly the scenario the pre-existing
   * gapDetected handling and periodic RESYNC_SAFETY_NET_INTERVAL_MS safety net already exist to
   * repair (see onTick below), so this composes safely with the existing design rather than
   * requiring a new repair mechanism.
   */
  private readonly pendingTickBySymbol = new Map<string, { price: number; volume: number; timestampMs: number }>();
  private readonly activeTickSymbols = new Set<string>();
  private inFlightTickCount = 0;

  private admitOrCoalesceTick(data: { symbol: string; price: number; volume: number; timestamp: string }): void {
    const symbol = String(data.symbol || '').toUpperCase();
    if (!symbol || !Number.isFinite(data.price)) return;
    const timestampMs = Date.parse(data.timestamp) || Date.now();

    // Local history bookkeeping happens for every admitted tick regardless of whether it ends up
    // dispatched or coalesced - coalescing throttles the NETWORK call, not what this bridge
    // itself remembers about real observed prices/volumes.
    this.trackLocalHistory(symbol, data.price, data.volume);

    const tick = { price: data.price, volume: data.volume, timestampMs };
    if (this.activeTickSymbols.has(symbol) || this.inFlightTickCount >= tradingSafety.quantJavaCoreTickMaxConcurrency) {
      this.pendingTickBySymbol.set(symbol, tick);
      return;
    }
    this.dispatchTick(symbol, tick);
  }

  private dispatchTick(symbol: string, tick: { price: number; volume: number; timestampMs: number }): void {
    this.pendingTickBySymbol.delete(symbol);
    this.activeTickSymbols.add(symbol);
    this.inFlightTickCount++;
    this.onTick(symbol, tick.price, tick.volume, tick.timestampMs)
      .catch(() => {
        /* fire-and-forget: never let a bridge failure surface into the live tick pipeline */
      })
      .finally(() => {
        this.activeTickSymbols.delete(symbol);
        this.inFlightTickCount--;
        const next = this.pendingTickBySymbol.get(symbol);
        if (next && this.inFlightTickCount < tradingSafety.quantJavaCoreTickMaxConcurrency) {
          this.dispatchTick(symbol, next);
        }
      });
  }

  /** Test-only. */
  getTickConcurrencyStateForTests(): { inFlight: number; pendingCount: number; activeSymbols: string[] } {
    return {
      inFlight: this.inFlightTickCount,
      pendingCount: this.pendingTickBySymbol.size,
      activeSymbols: Array.from(this.activeTickSymbols),
    };
  }

  private readonly onMarketData = (data: { symbol: string; price: number; volume: number; timestamp: string }) => {
    this.admitOrCoalesceTick(data);
  };

  start(): void {
    if (this.listening || !isQuantJavaCoreEnabled()) return;
    eventBus.subscribe('MARKET_DATA', this.onMarketData);
    this.listening = true;
  }

  stop(): void {
    if (!this.listening) return;
    eventBus.unsubscribe('MARKET_DATA', this.onMarketData);
    this.listening = false;
  }

  /**
   * Only called from dispatchTick() above, after admitOrCoalesceTick() has already validated the
   * symbol/price and recorded local history - symbol/price are trusted here, and timestampMs is
   * already resolved. Concurrency (at most one in-flight call per symbol, bounded globally by
   * quantJavaCoreTickMaxConcurrency) is enforced by the caller, not here.
   */
  private async onTick(symbol: string, price: number, volume: number, timestampMs: number): Promise<void> {
    if (!isQuantJavaCoreEnabled() || this.tickBreaker.isOpen()) return;

    const sequence = this.nextSequence(symbol);
    const gapDetected = await this.forwardTick(symbol, price, volume, timestampMs, sequence);
    if (gapDetected === null) return; // forwardTick itself failed (network/breaker/non-2xx) - nothing more to do
    const now = Date.now();
    if (gapDetected) {
      // Java told us it saw a non-consecutive sequence - resync immediately rather than let the
      // divergence persist until the next periodic safety-net resync. Fire-and-forget: a resync
      // failure is no worse than the gap that triggered it, and must never block tick processing.
      this.lastResyncAt[symbol] = now;
      void this.resyncSymbol(symbol).catch(() => {});
    } else {
      const lastResync = this.lastResyncAt[symbol] ?? 0;
      if (now - lastResync >= RESYNC_SAFETY_NET_INTERVAL_MS) {
        this.lastResyncAt[symbol] = now;
        void this.resyncSymbol(symbol).catch(() => {});
      }
    }

    const lastCompare = this.lastParityCompareAt[symbol] ?? 0;
    if (now - lastCompare >= PARITY_COMPARE_INTERVAL_MS) {
      this.lastParityCompareAt[symbol] = now;
      await this.compareParity(symbol);
    }
  }

  private nextSequence(symbol: string): number {
    const next = (this.sequenceBySymbol[symbol] ?? -1) + 1;
    this.sequenceBySymbol[symbol] = next;
    return next;
  }

  private trackLocalHistory(symbol: string, price: number, volume: number): void {
    const history = this.priceHistory[symbol] ?? (this.priceHistory[symbol] = []);
    history.push(price);
    // Must track tradingSafety.quantJavaCoreLocalHistoryCap == SymbolState.java's CircularDoubleArray
    // CAPACITY (200) - see that config field's own doc comment for why a shorter TS-side window
    // was a real, proven source of live parity divergence with no algorithm bug involved.
    if (history.length > tradingSafety.quantJavaCoreLocalHistoryCap) {
      history.shift();
    }
    const volumes = this.volumeHistory[symbol] ?? (this.volumeHistory[symbol] = []);
    volumes.push(Number.isFinite(volume) ? volume : 0);
    if (volumes.length > tradingSafety.quantJavaCoreLocalHistoryCap) {
      volumes.shift();
    }
  }

  /** Test-only. */
  getLocalHistoryLengthForTests(symbol: string): number {
    return this.priceHistory[symbol]?.length ?? 0;
  }

  /**
   * Returns true if Java reported a sequence gap, false if the tick was applied cleanly, or null
   * if the call itself failed (network/breaker/non-2xx) - three distinct outcomes, never collapsed
   * into one boolean the way the pre-2026-09-10 version did.
   */
  private async forwardTick(symbol: string, price: number, volume: number, timestampMs: number, sequence: number): Promise<boolean | null> {
    const startedAt = Date.now();
    const before = this.tickBreaker.getFailureCount();
    try {
      const res = await fetch(`${tradingSafety.quantJavaCoreBaseUrl}/api/v1/ticks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, symbol, price, volume, timestampMs, sequence }),
        signal: AbortSignal.timeout(tradingSafety.quantJavaCoreRequestTimeoutMs),
      });
      if (!res.ok) {
        this.tickBreaker.recordFailure();
        this.logBridgeOutcome({ endpoint: 'ticks', symbol, result: 'HTTP_ERROR', httpStatus: res.status, durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.tickBreaker.getFailureCount() });
        return null;
      }
      this.tickBreaker.recordSuccess();
      this.logBridgeOutcome({ endpoint: 'ticks', symbol, result: 'SUCCESS', durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: 0 });
      const body = await res.json().catch(() => null) as { gapDetected?: boolean } | null;
      return body?.gapDetected === true;
    } catch (e) {
      this.tickBreaker.recordFailure();
      this.logBridgeOutcome({ endpoint: 'ticks', symbol, result: this.classifyFetchError(e), errorMessage: e instanceof Error ? e.message : String(e), durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.tickBreaker.getFailureCount() });
      return null;
    }
  }

  /**
   * Wholesale resynchronization of Java's SymbolState from this bridge's own local history -
   * either reactively (Java reported a sequence gap) or as a periodic safety net (start(), and
   * every RESYNC_INTERVAL_MS thereafter per active symbol - see start()/scheduleSafetyNetResync()
   * below). Sends the current sequence counter as the new baseline so the very next ordinary tick
   * lines up as sequence+1 with no follow-on gap report. Fail-closed like every other bridge call:
   * a failed resync just means the next trigger (gap or periodic) tries again, never throws into a
   * live tick handler.
   */
  async resyncSymbol(symbol: string): Promise<boolean> {
    if (!isQuantJavaCoreEnabled() || this.tickBreaker.isOpen()) return false;
    const prices = this.priceHistory[symbol];
    if (!prices || prices.length === 0) return false;
    const volumes = this.volumeHistory[symbol] ?? [];
    const sequence = this.sequenceBySymbol[symbol] ?? 0;
    const startedAt = Date.now();
    const before = this.tickBreaker.getFailureCount();
    try {
      const res = await fetch(`${tradingSafety.quantJavaCoreBaseUrl}/api/v1/ticks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, timestampMs: Date.now(), resync: { prices, volumes, sequence } }),
        signal: AbortSignal.timeout(tradingSafety.quantJavaCoreRequestTimeoutMs),
      });
      if (!res.ok) {
        this.tickBreaker.recordFailure();
        this.logBridgeOutcome({ endpoint: 'ticks_resync', symbol, result: 'HTTP_ERROR', httpStatus: res.status, durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.tickBreaker.getFailureCount() });
        return false;
      }
      this.tickBreaker.recordSuccess();
      this.logBridgeOutcome({ endpoint: 'ticks_resync', symbol, result: 'SUCCESS', durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: 0 });
      observeSafe(() => {
        structuredLogger.info('quant_core_tick_resync_sent', {
          category: 'OBSERVABILITY',
          eventType: 'QUANT_CORE_TICK_RESYNC_SENT',
          symbol,
          reasoning: `Resynced Java state for ${symbol} from ${prices.length} canonical prices at sequence ${sequence}`,
        });
      });
      return true;
    } catch (e) {
      this.tickBreaker.recordFailure();
      this.logBridgeOutcome({ endpoint: 'ticks_resync', symbol, result: this.classifyFetchError(e), errorMessage: e instanceof Error ? e.message : String(e), durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.tickBreaker.getFailureCount() });
      return false;
    }
  }

  private tsSideSnapshot(symbol: string): ComparableIndicatorSnapshot | null {
    const history = this.priceHistory[symbol];
    if (!history || history.length < MIN_HISTORY_FOR_PARITY) return null;
    const macd = this.macdEngine.calculate(history);
    const bb = calcBollingerBands(history, 20);
    return {
      rsi: this.rsiEngine.calculate(history),
      macd: macd.macd,
      macdSignal: macd.signal,
      bbUpper: bb.upper,
      bbLower: bb.lower,
    };
  }

  private async compareParity(symbol: string): Promise<void> {
    const tsSnapshot = this.tsSideSnapshot(symbol);
    if (!tsSnapshot) return;

    try {
      const res = await fetch(`${tradingSafety.quantJavaCoreBaseUrl}/api/v1/indicators/${encodeURIComponent(symbol)}`, {
        headers: { 'X-Trace-Id': generateTraceId(symbol), 'X-Symbol': symbol },
        signal: AbortSignal.timeout(tradingSafety.quantJavaCoreRequestTimeoutMs),
      });
      if (!res.ok) return;
      const javaSnapshot = (await res.json()) as ComparableIndicatorSnapshot & { insufficientHistory?: boolean };
      if (javaSnapshot.insufficientHistory) return;

      const divergences = compareSnapshots(tsSnapshot, javaSnapshot);
      if (divergences.length === 0) return;

      observeSafe(() => {
        structuredLogger.warn('quant_core_parity_divergence', {
          category: 'OBSERVABILITY',
          component: 'QuantCoreBridge',
          symbol,
          eventType: 'QUANT_CORE_PARITY_DIVERGENCE',
          divergences,
        });
      });
    } catch {
      /* fail-open for shadow diagnostics only - never surfaces to the live pipeline */
    }
  }

  /**
   * SHADOW-ONLY: QuantSignalAgent.evaluateSymbol() calls this immediately after its own real
   * classifyRegime(bars) call, passing the same already-fetched bars and the real TS RegimeResult
   * it just computed. Fire-and-forget by design at the call site (never awaited by evaluateSymbol) -
   * this method itself never throws, never mutates strategyContext, never emits an idea, and never
   * changes evaluateSymbol's return value. Same fail-closed contract as compareParity(): any
   * disabled flag, open breaker, non-2xx response, or network error is a silent no-op.
   */
  async compareRegimeParity(symbol: string, bars: ResearchBar[], tsRegime: RegimeResult): Promise<void> {
    if (!isQuantJavaCoreEnabled() || this.institutionalBreaker.isOpen()) return;

    const now = Date.now();
    const lastCompare = this.lastRegimeParityCompareAt[symbol] ?? 0;
    if (now - lastCompare < PARITY_COMPARE_INTERVAL_MS) return;
    this.lastRegimeParityCompareAt[symbol] = now;

    try {
      const res = await fetch(`${tradingSafety.quantJavaCoreBaseUrl}/api/v1/features/regime/${encodeURIComponent(symbol)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Trace-Id': generateTraceId(symbol), 'X-Symbol': symbol },
        body: JSON.stringify({ bars: barsToJavaPayload(bars) }),
        signal: AbortSignal.timeout(tradingSafety.quantJavaCoreRequestTimeoutMs),
      });
      if (!res.ok) return;
      const javaRegime = (await res.json()) as ComparableRegimeSnapshot & { insufficientData?: boolean };
      if (javaRegime.insufficientData) return;

      const tsSnapshot: ComparableRegimeSnapshot = {
        regime: tsRegime.regime,
        trendStrength: tsRegime.trendStrength,
        volatility: tsRegime.volatility,
        marketStructure: tsRegime.marketStructure,
        confidence: tsRegime.confidence,
      };
      const divergences = compareRegimeSnapshots(tsSnapshot, javaRegime);
      if (divergences.length === 0) return;

      observeSafe(() => {
        structuredLogger.warn('quant_core_parity_divergence', {
          category: 'OBSERVABILITY',
          component: 'QuantCoreBridge',
          symbol,
          eventType: 'QUANT_CORE_REGIME_PARITY_DIVERGENCE',
          divergences,
        });
      });
    } catch {
      /* fail-open for shadow diagnostics only - never surfaces to the live pipeline */
    }
  }

  /** Non-blocking (short timeout), safe to call from a route/CLI handler. Updates the cache. */
  async health(): Promise<{ connected: boolean; checkedAt: string; detail?: string }> {
    if (!isQuantJavaCoreEnabled()) {
      this.lastKnownHealth = { connected: false, checkedAt: new Date().toISOString(), detail: 'QUANT_JAVA_CORE_ENABLED is false' };
      return this.lastKnownHealth;
    }
    try {
      const res = await fetch(`${tradingSafety.quantJavaCoreBaseUrl}/health`, {
        signal: AbortSignal.timeout(tradingSafety.quantJavaCoreRequestTimeoutMs),
      });
      this.lastKnownHealth = {
        connected: res.ok,
        checkedAt: new Date().toISOString(),
        detail: res.ok ? `HTTP ${res.status}` : `unhealthy: HTTP ${res.status}`,
      };
    } catch (e: any) {
      this.lastKnownHealth = { connected: false, checkedAt: new Date().toISOString(), detail: e?.message || 'unreachable' };
    }
    return this.lastKnownHealth;
  }

  cachedHealth(): { connected: boolean; checkedAt: string; detail?: string } {
    return this.lastKnownHealth;
  }

  /**
   * Advisory-only, on-demand callers for the Java institutional volatility/regime endpoints
   * (GarchEngine/HmmRegimeEngine, exposed over HTTP this session - see
   * docs/audits/ARGUS_JAVA_PYTHON_NODE_PERFORMANCE_BOUNDARY_AUDIT.md §5). Deliberately NOT wired
   * into any live emission/vote path here - "AVAILABLE BUT NOT AUTOMATICALLY ACTIVATED", matching
   * this session's own safety boundary: turning raw macro/volatility/regime numbers into a trade
   * direction is not something either of these functions does or should do. A caller may use the
   * returned numbers as reasoning/context (e.g. attached to an idea's `reasoning` string) but must
   * never treat them as an independent vote - only ChiefTraderAgent mints those, from
   * emitTradeIdea. Same fail-closed contract as forwardTick/compareParity: any error or disabled
   * flag returns null, never throws, never fabricates a result.
   */
  async fetchInstitutionalVolatility(symbol: string, bars: ResearchBar[], forecastStepsAhead = 1): Promise<InstitutionalVolatilityResult | null> {
    if (!isQuantJavaCoreEnabled()) return null;
    if (this.institutionalBreaker.isOpen()) {
      this.logBridgeOutcome({ endpoint: 'institutional/volatility', symbol, result: 'CIRCUIT_OPEN', breakerFailureCountBefore: this.institutionalBreaker.getFailureCount(), breakerFailureCountAfter: this.institutionalBreaker.getFailureCount() });
      return null;
    }
    const startedAt = Date.now();
    const before = this.institutionalBreaker.getFailureCount();
    try {
      const res = await fetch(`${tradingSafety.quantJavaCoreBaseUrl}/api/v1/institutional/volatility/${encodeURIComponent(symbol)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Trace-Id': generateTraceId(symbol), 'X-Symbol': symbol },
        body: JSON.stringify({ bars: barsToJavaPayload(bars), forecastStepsAhead }),
        signal: AbortSignal.timeout(tradingSafety.quantJavaCoreRequestTimeoutMs),
      });
      if (!res.ok) {
        this.institutionalBreaker.recordFailure();
        this.logBridgeOutcome({ endpoint: 'institutional/volatility', symbol, result: 'HTTP_ERROR', httpStatus: res.status, durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.institutionalBreaker.getFailureCount() });
        return null;
      }
      this.institutionalBreaker.recordSuccess();
      this.logBridgeOutcome({ endpoint: 'institutional/volatility', symbol, result: 'SUCCESS', durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: 0 });
      return (await res.json()) as InstitutionalVolatilityResult;
    } catch (e) {
      this.institutionalBreaker.recordFailure();
      this.logBridgeOutcome({ endpoint: 'institutional/volatility', symbol, result: this.classifyFetchError(e), errorMessage: e instanceof Error ? e.message : String(e), durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.institutionalBreaker.getFailureCount() });
      return null;
    }
  }

  async fetchInstitutionalFactors(symbol: string, bars: ResearchBar[], opts?: { momentumDays?: number; smaWindow?: number; zScoreWindow?: number }): Promise<InstitutionalFactorsResult | null> {
    if (!isQuantJavaCoreEnabled()) return null;
    if (this.institutionalBreaker.isOpen()) {
      this.logBridgeOutcome({ endpoint: 'institutional/factors', symbol, result: 'CIRCUIT_OPEN', breakerFailureCountBefore: this.institutionalBreaker.getFailureCount(), breakerFailureCountAfter: this.institutionalBreaker.getFailureCount() });
      return null;
    }
    const startedAt = Date.now();
    const before = this.institutionalBreaker.getFailureCount();
    try {
      const res = await fetch(`${tradingSafety.quantJavaCoreBaseUrl}/api/v1/institutional/factors/${encodeURIComponent(symbol)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Trace-Id': generateTraceId(symbol), 'X-Symbol': symbol },
        body: JSON.stringify({
          bars: barsToJavaPayload(bars),
          momentumDays: opts?.momentumDays ?? 20,
          smaWindow: opts?.smaWindow ?? 10,
          zScoreWindow: opts?.zScoreWindow ?? 60,
        }),
        signal: AbortSignal.timeout(tradingSafety.quantJavaCoreRequestTimeoutMs),
      });
      if (!res.ok) {
        this.institutionalBreaker.recordFailure();
        this.logBridgeOutcome({ endpoint: 'institutional/factors', symbol, result: 'HTTP_ERROR', httpStatus: res.status, durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.institutionalBreaker.getFailureCount() });
        return null;
      }
      this.institutionalBreaker.recordSuccess();
      this.logBridgeOutcome({ endpoint: 'institutional/factors', symbol, result: 'SUCCESS', durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: 0 });
      return (await res.json()) as InstitutionalFactorsResult;
    } catch (e) {
      this.institutionalBreaker.recordFailure();
      this.logBridgeOutcome({ endpoint: 'institutional/factors', symbol, result: this.classifyFetchError(e), errorMessage: e instanceof Error ? e.message : String(e), durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.institutionalBreaker.getFailureCount() });
      return null;
    }
  }

  /**
   * FeaturePipeline's real MarketDataQualityEngine gate (docs/audits/ARGUS_JAVA_QUANT_ENGINE_BOUNDARY_AND_BENCHMARK_AUDIT.md's
   * institutional activation Phase 1 foundation) - a caller should check qualityReport.status
   * before trusting the indicator fields, same discipline the Java side itself enforces (RED
   * quality never even builds a snapshot server-side; this returns null in that case too).
   */
  /**
   * 2026-09-09: reaches the generic /institutional/strategy/{strategyId}/{symbol} dispatcher
   * (QuantCoreServer.java) that HTTP-exposes the batch of previously-endpoint-less RESEARCH
   * engines. Returns the raw response map as-is (each strategyId has its own real field shape -
   * see QuantCoreServer.java's evaluateResearchStrategy() switch) rather than a typed interface
   * per engine, matching this bridge's own fail-closed contract: null on any error/disabled-flag/
   * insufficient-data (HTTP 422)/unknown-strategyId (404), never fabricated.
   */
  async fetchResearchStrategy(strategyId: string, symbol: string, bars: ResearchBar[], params?: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const endpoint = `institutional/strategy/${strategyId}`;
    if (!isQuantJavaCoreEnabled()) return null;
    if (this.researchBreaker.isOpen()) {
      this.logBridgeOutcome({ endpoint, symbol, result: 'CIRCUIT_OPEN', breakerFailureCountBefore: this.researchBreaker.getFailureCount(), breakerFailureCountAfter: this.researchBreaker.getFailureCount() });
      return null;
    }
    const startedAt = Date.now();
    const before = this.researchBreaker.getFailureCount();
    try {
      const res = await fetch(`${tradingSafety.quantJavaCoreBaseUrl}/api/v1/institutional/strategy/${encodeURIComponent(strategyId)}/${encodeURIComponent(symbol)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Trace-Id': generateTraceId(symbol), 'X-Symbol': symbol },
        body: JSON.stringify({ bars: barsToJavaPayload(bars), ...(params ?? {}) }),
        signal: AbortSignal.timeout(tradingSafety.quantJavaCoreRequestTimeoutMs),
      });
      if (!res.ok) {
        this.researchBreaker.recordFailure();
        this.logBridgeOutcome({ endpoint, symbol, result: 'HTTP_ERROR', httpStatus: res.status, durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.researchBreaker.getFailureCount() });
        return null;
      }
      this.researchBreaker.recordSuccess();
      this.logBridgeOutcome({ endpoint, symbol, result: 'SUCCESS', durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: 0 });
      return (await res.json()) as Record<string, unknown>;
    } catch (e) {
      this.researchBreaker.recordFailure();
      this.logBridgeOutcome({ endpoint, symbol, result: this.classifyFetchError(e), errorMessage: e instanceof Error ? e.message : String(e), durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.researchBreaker.getFailureCount() });
      return null;
    }
  }

  /**
   * 2026-09-10: real, bars-owning path for the 5 CORE strategies
   * (docs/audits/ARGUS_JAVA_QUANT_AUTHORITY_ADR_2026-09-10.md §0/§21) — POSTs raw bars (this
   * bridge's own TS-fetched market data, the same role it already plays for
   * fetchResearchStrategy/fetchInstitutionalFactors) to QuantCoreServer's
   * /api/v1/quant/strategy/{strategyId}/{symbol}, where Java computes every feature itself via
   * FeaturesToStrategyContextAdapter and runs the real strategy — never a TS-precomputed
   * StrategyContext. Deliberately distinct from the older /api/v1/evaluate route
   * (StrategyContextCodec-based), which only ever proved decision-logic parity given identical
   * hand-built inputs. Fail-closed like every other method here: null on flag-off/breaker-open/
   * non-2xx/thrown error, never fabricated.
   */
  async fetchCoreStrategyAssessment(strategyId: string, symbol: string, bars: ResearchBar[]): Promise<CoreStrategyAssessment | null> {
    const endpoint = `quant/strategy/${strategyId}`;
    if (!isQuantJavaCoreEnabled()) return null;
    if (this.institutionalBreaker.isOpen()) {
      this.logBridgeOutcome({ endpoint, symbol, result: 'CIRCUIT_OPEN', breakerFailureCountBefore: this.institutionalBreaker.getFailureCount(), breakerFailureCountAfter: this.institutionalBreaker.getFailureCount() });
      return null;
    }
    const startedAt = Date.now();
    const before = this.institutionalBreaker.getFailureCount();
    try {
      const res = await fetch(`${tradingSafety.quantJavaCoreBaseUrl}/api/v1/quant/strategy/${encodeURIComponent(strategyId)}/${encodeURIComponent(symbol)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Trace-Id': generateTraceId(symbol), 'X-Symbol': symbol },
        body: JSON.stringify({ bars: barsToJavaPayload(bars) }),
        signal: AbortSignal.timeout(tradingSafety.quantJavaCoreRequestTimeoutMs),
      });
      if (!res.ok) {
        this.institutionalBreaker.recordFailure();
        this.logBridgeOutcome({ endpoint, symbol, result: 'HTTP_ERROR', httpStatus: res.status, durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.institutionalBreaker.getFailureCount() });
        return null;
      }
      this.institutionalBreaker.recordSuccess();
      this.logBridgeOutcome({ endpoint, symbol, result: 'SUCCESS', durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: 0 });
      return (await res.json()) as CoreStrategyAssessment;
    } catch (e) {
      this.institutionalBreaker.recordFailure();
      this.logBridgeOutcome({ endpoint, symbol, result: this.classifyFetchError(e), errorMessage: e instanceof Error ? e.message : String(e), durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.institutionalBreaker.getFailureCount() });
      return null;
    }
  }

  /**
   * Same real, bars-owning path as fetchCoreStrategyAssessment, but for all 5 CORE strategies
   * combined through QuantCoreServer's own QuantEnsembleEngine.combine() call (the existing
   * Kish/Grinold-Kahn correlation-adjusted math — never a second, duplicate combination system on
   * this side). status (HEALTHY/DEGRADED/UNAVAILABLE) is reported separately from direction
   * (BUY/SELL/HOLD) — a HOLD is a real evaluated outcome, UNAVAILABLE means nothing could be
   * evaluated at all; callers must not conflate the two.
   */
  async fetchCoreEnsembleDecision(symbol: string, bars: ResearchBar[]): Promise<CoreEnsembleDecision | null> {
    if (!isQuantJavaCoreEnabled()) return null;
    if (this.ensembleBreaker.isOpen()) {
      this.logBridgeOutcome({ endpoint: 'quant/ensemble', symbol, result: 'CIRCUIT_OPEN', breakerFailureCountBefore: this.ensembleBreaker.getFailureCount(), breakerFailureCountAfter: this.ensembleBreaker.getFailureCount() });
      return null;
    }
    const startedAt = Date.now();
    const before = this.ensembleBreaker.getFailureCount();
    try {
      const res = await fetch(`${tradingSafety.quantJavaCoreBaseUrl}/api/v1/quant/ensemble/${encodeURIComponent(symbol)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Trace-Id': generateTraceId(symbol), 'X-Symbol': symbol },
        body: JSON.stringify({ bars: barsToJavaPayload(bars) }),
        signal: AbortSignal.timeout(tradingSafety.quantJavaCoreRequestTimeoutMs),
      });
      if (!res.ok) {
        this.ensembleBreaker.recordFailure();
        this.logBridgeOutcome({ endpoint: 'quant/ensemble', symbol, result: 'HTTP_ERROR', httpStatus: res.status, durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.ensembleBreaker.getFailureCount() });
        return null;
      }
      this.ensembleBreaker.recordSuccess();
      this.logBridgeOutcome({ endpoint: 'quant/ensemble', symbol, result: 'SUCCESS', durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: 0 });
      return (await res.json()) as CoreEnsembleDecision;
    } catch (e) {
      this.ensembleBreaker.recordFailure();
      this.logBridgeOutcome({ endpoint: 'quant/ensemble', symbol, result: this.classifyFetchError(e), errorMessage: e instanceof Error ? e.message : String(e), durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.ensembleBreaker.getFailureCount() });
      return null;
    }
  }

  async fetchInstitutionalFeatures(symbol: string, bars: ResearchBar[], asOfMs?: number): Promise<InstitutionalFeaturesResult | null> {
    if (!isQuantJavaCoreEnabled()) return null;
    if (this.institutionalBreaker.isOpen()) {
      this.logBridgeOutcome({ endpoint: 'institutional/features', symbol, result: 'CIRCUIT_OPEN', breakerFailureCountBefore: this.institutionalBreaker.getFailureCount(), breakerFailureCountAfter: this.institutionalBreaker.getFailureCount() });
      return null;
    }
    const startedAt = Date.now();
    const before = this.institutionalBreaker.getFailureCount();
    try {
      const res = await fetch(`${tradingSafety.quantJavaCoreBaseUrl}/api/v1/institutional/features/${encodeURIComponent(symbol)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Trace-Id': generateTraceId(symbol), 'X-Symbol': symbol },
        body: JSON.stringify({ bars: barsToJavaPayload(bars), ...(asOfMs !== undefined ? { asOfMs } : {}) }),
        signal: AbortSignal.timeout(tradingSafety.quantJavaCoreRequestTimeoutMs),
      });
      if (!res.ok) {
        this.institutionalBreaker.recordFailure();
        this.logBridgeOutcome({ endpoint: 'institutional/features', symbol, result: 'HTTP_ERROR', httpStatus: res.status, durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.institutionalBreaker.getFailureCount() });
        return null;
      }
      this.institutionalBreaker.recordSuccess();
      this.logBridgeOutcome({ endpoint: 'institutional/features', symbol, result: 'SUCCESS', durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: 0 });
      return (await res.json()) as InstitutionalFeaturesResult;
    } catch (e) {
      this.institutionalBreaker.recordFailure();
      this.logBridgeOutcome({ endpoint: 'institutional/features', symbol, result: this.classifyFetchError(e), errorMessage: e instanceof Error ? e.message : String(e), durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.institutionalBreaker.getFailureCount() });
      return null;
    }
  }

  /** CorrelationEngine (EwmaCovariance) - needs pre-computed simple returns per symbol, not raw bars (a correlation is inherently cross-symbol, unlike the single-symbol callers above). */
  async fetchInstitutionalCorrelation(symbols: string[], returnsByAsset: number[][], lambda?: number): Promise<InstitutionalCorrelationResult | null> {
    if (!isQuantJavaCoreEnabled()) return null;
    if (this.institutionalBreaker.isOpen()) {
      this.logBridgeOutcome({ endpoint: 'institutional/correlation', result: 'CIRCUIT_OPEN', breakerFailureCountBefore: this.institutionalBreaker.getFailureCount(), breakerFailureCountAfter: this.institutionalBreaker.getFailureCount() });
      return null;
    }
    const startedAt = Date.now();
    const before = this.institutionalBreaker.getFailureCount();
    try {
      const res = await fetch(`${tradingSafety.quantJavaCoreBaseUrl}/api/v1/institutional/correlation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Trace-Id': generateTraceId(symbols[0] ?? 'CORR') },
        body: JSON.stringify({ symbols, returnsByAsset, ...(lambda !== undefined ? { lambda } : {}) }),
        signal: AbortSignal.timeout(tradingSafety.quantJavaCoreRequestTimeoutMs),
      });
      if (!res.ok) {
        this.institutionalBreaker.recordFailure();
        this.logBridgeOutcome({ endpoint: 'institutional/correlation', result: 'HTTP_ERROR', httpStatus: res.status, durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.institutionalBreaker.getFailureCount() });
        return null;
      }
      this.institutionalBreaker.recordSuccess();
      this.logBridgeOutcome({ endpoint: 'institutional/correlation', result: 'SUCCESS', durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: 0 });
      return (await res.json()) as InstitutionalCorrelationResult;
    } catch (e) {
      this.institutionalBreaker.recordFailure();
      this.logBridgeOutcome({ endpoint: 'institutional/correlation', result: this.classifyFetchError(e), errorMessage: e instanceof Error ? e.message : String(e), durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.institutionalBreaker.getFailureCount() });
      return null;
    }
  }

  /**
   * QuantEnsembleEngine (correlation-adjusted ensemble) - a caller supplies already-derived
   * directional votes (this function does not itself decide what counts as a "directional vote";
   * never force a non-directional signal like a raw volatility forecast into a fabricated
   * BUY/SELL here). Same fail-closed contract as every other institutional caller.
   *
   * 2026-09-11 observability addition (P0 "diagnose the Quant internal ensemble null path"
   * investigation - real finding: Sept 10's 230/230 null rate traced to a real ~9.5h process
   * outage that night, NOT votes.length===0 (disproven directly) and NOT a code defect in this
   * handler (verified live: today's process answers the exact real Sept 10 payload shape
   * correctly). What genuinely was missing is this: every failure mode - Java disabled, circuit
   * breaker open, a real HTTP error, a timeout/network failure - collapsed into an
   * indistinguishable bare `null`, making a future recurrence unanswerable without a manual
   * multi-hour forensic reconstruction like this one. This block classifies and logs the REAL
   * outcome of every call, still returning exactly the same `| null` contract every existing
   * caller already handles - purely additive, no caller needs to change.
   */
  async fetchInstitutionalEnsemble(votes: EnsembleModelVote[], correlationMatrix?: number[][]): Promise<InstitutionalEnsembleResult | null> {
    const logOutcome = (outcome: EnsembleCallOutcome, detail?: string) => {
      observeSafe(() => {
        structuredLogger.info('quant_ensemble_call_outcome', {
          category: 'OBSERVABILITY',
          eventType: 'QUANT_ENSEMBLE_CALL_OUTCOME',
          reasoning: `votes=${votes.length} outcome=${outcome}${detail ? ` detail=${detail}` : ''}`,
        });
      });
    };
    if (!isQuantJavaCoreEnabled()) {
      logOutcome('JAVA_DISABLED');
      return null;
    }
    if (this.ensembleBreaker.isOpen()) {
      logOutcome('CIRCUIT_BREAKER_OPEN');
      this.logBridgeOutcome({ endpoint: 'institutional/ensemble', result: 'CIRCUIT_OPEN', breakerFailureCountBefore: this.ensembleBreaker.getFailureCount(), breakerFailureCountAfter: this.ensembleBreaker.getFailureCount() });
      return null;
    }
    const startedAt = Date.now();
    const before = this.ensembleBreaker.getFailureCount();
    try {
      const res = await fetch(`${tradingSafety.quantJavaCoreBaseUrl}/api/v1/institutional/ensemble`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Trace-Id': generateTraceId(votes[0]?.modelId ?? 'ENSEMBLE') },
        body: JSON.stringify({ votes, ...(correlationMatrix !== undefined ? { correlationMatrix } : {}) }),
        signal: AbortSignal.timeout(tradingSafety.quantJavaCoreRequestTimeoutMs),
      });
      if (!res.ok) {
        this.ensembleBreaker.recordFailure();
        logOutcome('HTTP_ERROR', String(res.status));
        this.logBridgeOutcome({ endpoint: 'institutional/ensemble', result: 'HTTP_ERROR', httpStatus: res.status, durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.ensembleBreaker.getFailureCount() });
        return null;
      }
      this.ensembleBreaker.recordSuccess();
      logOutcome('SUCCESS');
      this.logBridgeOutcome({ endpoint: 'institutional/ensemble', result: 'SUCCESS', durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: 0 });
      return (await res.json()) as InstitutionalEnsembleResult;
    } catch (e) {
      this.ensembleBreaker.recordFailure();
      logOutcome('NETWORK_ERROR_OR_TIMEOUT', e instanceof Error ? e.message : String(e));
      this.logBridgeOutcome({ endpoint: 'institutional/ensemble', result: this.classifyFetchError(e), errorMessage: e instanceof Error ? e.message : String(e), durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.ensembleBreaker.getFailureCount() });
      return null;
    }
  }

  /**
   * The Dynamic Regime & Volatility Multiplier Layer - computes the correlation-adjusted ensemble
   * and applies RegimeVolatilityOverlay's regime-suitability + inverse-volatility-targeting scale
   * in one call. currentVolatility should come from a real number the caller already has (e.g.
   * an InstitutionalVolatilityResult's or InstitutionalRegimeResult's own realizedVolatility field) -
   * never fabricate one. Same fail-closed contract as every other institutional caller.
   */
  async fetchInstitutionalAdvisory(votes: EnsembleModelVote[], regime: HmmRegimeLabel, currentVolatility: number, correlationMatrix?: number[][]): Promise<InstitutionalAdvisoryResult | null> {
    if (!isQuantJavaCoreEnabled()) return null;
    if (this.ensembleBreaker.isOpen()) {
      this.logBridgeOutcome({ endpoint: 'institutional/advisory', result: 'CIRCUIT_OPEN', breakerFailureCountBefore: this.ensembleBreaker.getFailureCount(), breakerFailureCountAfter: this.ensembleBreaker.getFailureCount() });
      return null;
    }
    const startedAt = Date.now();
    const before = this.ensembleBreaker.getFailureCount();
    try {
      const res = await fetch(`${tradingSafety.quantJavaCoreBaseUrl}/api/v1/institutional/advisory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Trace-Id': generateTraceId(votes[0]?.modelId ?? 'ADVISORY') },
        body: JSON.stringify({ votes, regime, currentVolatility, ...(correlationMatrix !== undefined ? { correlationMatrix } : {}) }),
        signal: AbortSignal.timeout(tradingSafety.quantJavaCoreRequestTimeoutMs),
      });
      if (!res.ok) {
        this.ensembleBreaker.recordFailure();
        this.logBridgeOutcome({ endpoint: 'institutional/advisory', result: 'HTTP_ERROR', httpStatus: res.status, durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.ensembleBreaker.getFailureCount() });
        return null;
      }
      this.ensembleBreaker.recordSuccess();
      this.logBridgeOutcome({ endpoint: 'institutional/advisory', result: 'SUCCESS', durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: 0 });
      return (await res.json()) as InstitutionalAdvisoryResult;
    } catch (e) {
      this.ensembleBreaker.recordFailure();
      this.logBridgeOutcome({ endpoint: 'institutional/advisory', result: this.classifyFetchError(e), errorMessage: e instanceof Error ? e.message : String(e), durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.ensembleBreaker.getFailureCount() });
      return null;
    }
  }

  async fetchInstitutionalRegime(symbol: string, bars: ResearchBar[], realizedVolWindow = 10): Promise<InstitutionalRegimeResult | null> {
    if (!isQuantJavaCoreEnabled()) return null;
    if (this.institutionalBreaker.isOpen()) {
      this.logBridgeOutcome({ endpoint: 'institutional/regime', symbol, result: 'CIRCUIT_OPEN', breakerFailureCountBefore: this.institutionalBreaker.getFailureCount(), breakerFailureCountAfter: this.institutionalBreaker.getFailureCount() });
      return null;
    }
    const startedAt = Date.now();
    const before = this.institutionalBreaker.getFailureCount();
    try {
      const res = await fetch(`${tradingSafety.quantJavaCoreBaseUrl}/api/v1/institutional/regime/${encodeURIComponent(symbol)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Trace-Id': generateTraceId(symbol), 'X-Symbol': symbol },
        body: JSON.stringify({ bars: barsToJavaPayload(bars), realizedVolWindow }),
        signal: AbortSignal.timeout(tradingSafety.quantJavaCoreRequestTimeoutMs),
      });
      if (!res.ok) {
        this.institutionalBreaker.recordFailure();
        this.logBridgeOutcome({ endpoint: 'institutional/regime', symbol, result: 'HTTP_ERROR', httpStatus: res.status, durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.institutionalBreaker.getFailureCount() });
        return null;
      }
      this.institutionalBreaker.recordSuccess();
      this.logBridgeOutcome({ endpoint: 'institutional/regime', symbol, result: 'SUCCESS', durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: 0 });
      return (await res.json()) as InstitutionalRegimeResult;
    } catch (e) {
      this.institutionalBreaker.recordFailure();
      this.logBridgeOutcome({ endpoint: 'institutional/regime', symbol, result: this.classifyFetchError(e), errorMessage: e instanceof Error ? e.message : String(e), durationMs: Date.now() - startedAt, breakerFailureCountBefore: before, breakerFailureCountAfter: this.institutionalBreaker.getFailureCount() });
      return null;
    }
  }

  /**
   * Phase 3: translate a Java StrategySignal into the same TRADE_IDEA_GENERATED shape every
   * other agent produces. Fails closed (drops the idea, never throws) on any malformed field.
   * No-op entirely unless isLiveIdeaEmissionEnabled() (both flags on).
   */
  onSignal(raw: RawJavaSignal): void {
    if (!isLiveIdeaEmissionEnabled()) return;

    const symbol = looksLikeListedTicker(raw.symbol);
    if (!symbol) return;

    const side = raw.side === 'BUY' || raw.side === 'SELL' ? raw.side : null;
    if (!side) return;

    const confidenceRaw = Number(raw.confidence);
    if (!Number.isFinite(confidenceRaw)) return;
    const confidence = Math.max(0, Math.min(1, confidenceRaw));

    const currentPrice = Number(raw.currentPrice);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) return;

    const strategyId = typeof raw.strategyId === 'string' ? raw.strategyId : 'UNKNOWN_STRATEGY';
    const reasoning = typeof raw.reasoning === 'string' ? raw.reasoning : '';

    eventBus.emitTradeIdea({
      traceId: generateTraceId(symbol),
      symbol,
      side,
      confidence,
      currentPrice,
      agent: 'QuantCoreJava',
      reasoning: `QuantCoreJava/${strategyId}: ${reasoning}`,
    });
  }
}

export const quantCoreBridge = new QuantCoreBridgeService();
