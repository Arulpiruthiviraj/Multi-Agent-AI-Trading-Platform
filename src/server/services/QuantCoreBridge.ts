/**
 * TypeScript-side client for the local, advisory-only Java Quant Core process
 * (docs/architecture/JAVA_QUANT_CORE_MIGRATION_BLUEPRINT.md, Phases 2-3).
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
import { compareSnapshots, ComparableIndicatorSnapshot } from './ParityComparator';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';
import type { ResearchBar } from '../research/ohlcvTypes';

const QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED_ENV_VAR = 'QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED';
const MIN_HISTORY_FOR_PARITY = 26; // matches SymbolState.java's MIN_HISTORY_FOR_INDICATORS
const PARITY_COMPARE_INTERVAL_MS = 60_000; // per-symbol debounce - never compares every tick

function isLiveIdeaEmissionEnabled(): boolean {
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
}

export class QuantCoreBridgeService {
  private listening = false;
  private readonly priceHistory: Record<string, number[]> = {};
  private readonly lastParityCompareAt: Record<string, number> = {};
  private readonly breaker = new CircuitBreaker();
  private readonly rsiEngine = new RSIEngine(14);
  private readonly macdEngine = new MACDEngine(12, 26, 9);
  /** Cached, non-blocking - refreshed by health(); read by the CLI/API route without a live network hop. */
  private lastKnownHealth: { connected: boolean; checkedAt: string; detail?: string } = {
    connected: false,
    checkedAt: new Date(0).toISOString(),
    detail: 'never checked',
  };

  private readonly onMarketData = (data: { symbol: string; price: number; volume: number; timestamp: string }) => {
    this.onTick(data).catch(() => {
      /* fire-and-forget: never let a bridge failure surface into the live tick pipeline */
    });
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

  private async onTick(data: { symbol: string; price: number; volume: number; timestamp: string }): Promise<void> {
    if (!isQuantJavaCoreEnabled() || this.breaker.isOpen()) return;
    const symbol = String(data.symbol || '').toUpperCase();
    if (!symbol || !Number.isFinite(data.price)) return;

    const timestampMs = Date.parse(data.timestamp) || Date.now();
    this.trackLocalHistory(symbol, data.price);

    const ok = await this.forwardTick(symbol, data.price, data.volume, timestampMs);
    if (!ok) return;

    const now = Date.now();
    const lastCompare = this.lastParityCompareAt[symbol] ?? 0;
    if (now - lastCompare >= PARITY_COMPARE_INTERVAL_MS) {
      this.lastParityCompareAt[symbol] = now;
      await this.compareParity(symbol);
    }
  }

  private trackLocalHistory(symbol: string, price: number): void {
    const history = this.priceHistory[symbol] ?? (this.priceHistory[symbol] = []);
    history.push(price);
    if (history.length > MIN_HISTORY_FOR_PARITY * 2) {
      history.shift();
    }
  }

  private async forwardTick(symbol: string, price: number, volume: number, timestampMs: number): Promise<boolean> {
    try {
      const res = await fetch(`${tradingSafety.quantJavaCoreBaseUrl}/api/v1/ticks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, symbol, price, volume, timestampMs }),
        signal: AbortSignal.timeout(tradingSafety.quantJavaCoreRequestTimeoutMs),
      });
      if (!res.ok) {
        this.breaker.recordFailure();
        return false;
      }
      this.breaker.recordSuccess();
      return true;
    } catch {
      this.breaker.recordFailure();
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
    if (!isQuantJavaCoreEnabled() || this.breaker.isOpen()) return null;
    try {
      const res = await fetch(`${tradingSafety.quantJavaCoreBaseUrl}/api/v1/institutional/volatility/${encodeURIComponent(symbol)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Trace-Id': generateTraceId(symbol), 'X-Symbol': symbol },
        body: JSON.stringify({ bars: barsToJavaPayload(bars), forecastStepsAhead }),
        signal: AbortSignal.timeout(tradingSafety.quantJavaCoreRequestTimeoutMs),
      });
      if (!res.ok) {
        this.breaker.recordFailure();
        return null;
      }
      this.breaker.recordSuccess();
      return (await res.json()) as InstitutionalVolatilityResult;
    } catch {
      this.breaker.recordFailure();
      return null;
    }
  }

  async fetchInstitutionalFactors(symbol: string, bars: ResearchBar[], opts?: { momentumDays?: number; smaWindow?: number; zScoreWindow?: number }): Promise<InstitutionalFactorsResult | null> {
    if (!isQuantJavaCoreEnabled() || this.breaker.isOpen()) return null;
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
        this.breaker.recordFailure();
        return null;
      }
      this.breaker.recordSuccess();
      return (await res.json()) as InstitutionalFactorsResult;
    } catch {
      this.breaker.recordFailure();
      return null;
    }
  }

  async fetchInstitutionalRegime(symbol: string, bars: ResearchBar[], realizedVolWindow = 10): Promise<InstitutionalRegimeResult | null> {
    if (!isQuantJavaCoreEnabled() || this.breaker.isOpen()) return null;
    try {
      const res = await fetch(`${tradingSafety.quantJavaCoreBaseUrl}/api/v1/institutional/regime/${encodeURIComponent(symbol)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Trace-Id': generateTraceId(symbol), 'X-Symbol': symbol },
        body: JSON.stringify({ bars: barsToJavaPayload(bars), realizedVolWindow }),
        signal: AbortSignal.timeout(tradingSafety.quantJavaCoreRequestTimeoutMs),
      });
      if (!res.ok) {
        this.breaker.recordFailure();
        return null;
      }
      this.breaker.recordSuccess();
      return (await res.json()) as InstitutionalRegimeResult;
    } catch {
      this.breaker.recordFailure();
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
