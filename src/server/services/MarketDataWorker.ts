/**
 * ==========================================================
 * Module: MarketDataWorker.ts
 *
 * Alpaca IEX top-of-book WebSocket. Does not fabricate ticks.
 *
 * Real bugs this file closes:
 * - start() used to no-op whenever `this.ws` was non-null, including CLOSED sockets,
 *   so a failed handshake never recovered except via a 5s close timer.
 * - POST /diagnostics/retry/market_data was status-only.
 * - Nobody called subscribe(), so even an OPEN socket requested zero quotes.
 * - Oversized subscribe sets + "symbol limit exceeded" caused a reconnect storm;
 *   recovery now shrinks to coreStreamingSymbols and resubscribes in place.
 *
 * TechnicalAgent listens to MARKET_DATA ticks (event-driven, not a fixed 60s interval).
 * Fund/Macro poll on runtimeIntervals.fundamentalAgentMs / macroAgentMs (60s / 75s).
 * ==========================================================
 */

import WebSocket from 'ws';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { isAutobotTradingEnabled } from '../core/ideaGenerationGate';
import { ReconnectBackoff } from '../core/reconnectBackoff';
import { alpacaWebSocketTlsOptions } from '../core/alpacaTls';
import { tradingSafety } from '../config/tradingSafety';
import { looksLikeListedTicker } from '../ai/AIOutputValidator';
import { continuousIntelligence } from '../config/continuousIntelligence';
import { isMarketDataWebSocketAuthorized } from '../core/marketDataWsOwnership';
import { notePipelineAgentTick } from '../core/pipelineAgentHealth';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';
import { logDiscoveryCandidateDecision } from '../observability/discoveryCandidateLedger';
import { hasRealCatalystEvidence } from './NewsCatalystStore';

const DEFAULT_STREAM_URL = 'wss://stream.data.alpaca.markets/v2/iex';

/**
 * Phase 18 (2026-09-01 rescue-fairness fix). Real evidence (Phase 17 forensic audit): the
 * temporary-rescue pool had no concept of WHY a request was made - a routine repeat-requester
 * (a symbol needing rescue every cycle for hours) and a rare, bounded exploration promotion
 * competed for the same slots on equal footing. Live-observed: AAPL/TSLA/AI occupied all 3 slots
 * for hours; two real exploration promotions (CRM->MOMENTUM_BREAKOUT, ONON->TREND_FOLLOWING) were
 * both denied RESCUE_CAPACITY_FULL. ROUTINE_RECOVERY is the pre-existing, undifferentiated case
 * (a strategy idea discarded solely by stale data, requesting one more cycle's chance - unchanged
 * behavior for any caller that does not specify a class, preserving exact backward compatibility).
 * EXPLORATION/MARKET_MOVER identify requests this fix specifically protects a reserved allowance
 * for (see rescueReservedSlotsForPriorityClasses).
 *
 * 'NEWS_CATALYST' added Phase 28 (2026-09-02 P0 discovery fix, real FRVO incident 2026-09-01): a
 * candidate backed by real, reviewed news-catalyst evidence (NewsCatalystStore.hasRealCatalystEvidence())
 * gets the SAME bounded priority treatment as EXPLORATION/MARKET_MOVER - it is not narrowed by the
 * ROUTINE_RECOVERY reserved-capacity rule below (see the `requestClass === 'ROUTINE_RECOVERY'` check).
 */
export type RescueRequestClass = 'ROUTINE_RECOVERY' | 'EXPLORATION' | 'MARKET_MOVER' | 'NEWS_CATALYST';

export type RescueDeniedReason =
  | 'INVALID_SYMBOL'
  | 'RESCUE_CAPACITY_FULL'
  | 'ROUTINE_CAPACITY_RESERVED_FOR_PRIORITY'
  | 'AT_CAPACITY_NO_SAFE_EVICTION';

/**
 * Phase 28 (2026-09-02 P0 discovery fix). Confirmed root cause of the real FRVO incident
 * (2026-09-01): the concurrent-rescue budget made no distinction between a request that needs a
 * candidate's FIRST live tick (NEW_DATA_ACQUISITION) and one that merely extends an
 * ALREADY-SUBSCRIBED symbol's eviction-immunity window (RENEWAL). Live evidence: AAPL/TSLA/ABNB
 * were already subscribed and only ever needed RENEWAL, yet their requests occupied the SAME
 * budget FRVO's genuine NEW_DATA_ACQUISITION request needed - FRVO was denied RESCUE_CAPACITY_FULL
 * 11 times in a row purely because renewal-only traffic had exhausted the shared pool.
 *
 * Derived from the symbol's ACTUAL current subscription state at request time
 * (`activeStreams.has(ticker)`) - never inferred from requestClass, reason text, or caller
 * identity, and never passed in by the caller.
 */
export type RescueIntent = 'NEW_DATA_ACQUISITION' | 'RENEWAL';

function quoteKey(symbol: string): string {
  return String(symbol || '').trim().toUpperCase();
}

function defaultStreamingCap(): number {
  return continuousIntelligence.maxActiveSubscriptions;
}

export type MarketDataQuoteBackend = 'alpaca' | 'ibkr_gateway';

type IbkrQuoteBridge = {
  subscribe(symbol: string): void;
  unsubscribe(symbol: string): void;
  clear(): void;
  /**
   * Real gateway-socket connectivity (2026-08-25 readiness audit, Phase 3): optional so existing
   * callers/tests that construct a bridge without it keep working, falling back to the older
   * (weaker) activeStreams-based guess below.
   */
  isConnected?(): boolean;
};

function coreStreamingSet(): Set<string> {
  return new Set(continuousIntelligence.coreStreamingSymbols.map((s) => quoteKey(s)).filter(Boolean));
}

function protectedStreamingSet(): Set<string> {
  return new Set(continuousIntelligence.protectedSymbols.map((s) => quoteKey(s)).filter(Boolean));
}

/** Prefer reviewed core + seed lists (under cap) over markets.json DIA/etc. overflow. */
function defaultSubscribeSymbols(cap: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [
    ...continuousIntelligence.coreStreamingSymbols,
    ...continuousIntelligence.seedSymbols,
  ]) {
    const ticker = looksLikeListedTicker(raw) || quoteKey(raw);
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    out.push(ticker);
    if (out.length >= cap) break;
  }
  return out;
}

export class MarketDataWorker {
  private activeStreams: Set<string> = new Set();
  private intervalId: NodeJS.Timeout | null = null;
  private ws: WebSocket | null = null;
  private latestPrices: Map<string, number> = new Map();
  private latestPriceTimestamps: Map<string, number> = new Map();
  /** Extended-Hours Execution Policy (2026-09-05): Alpaca's real-time quote message ("q") already
   *  carries an ask price (msg.ap) alongside the bid (msg.bp) this class already captures - it was
   *  simply never stored. This is the one real source of a genuine bid/ask spread anywhere in this
   *  codebase (there is no L2 feed - see CLAUDE.md's "L2 Depth Data Unavailable" honesty rule).
   *  Timestamped the same way latestPriceTimestamps is, so staleness can be checked the same way. */
  private latestAskPrices: Map<string, number> = new Map();
  private latestAskTimestamps: Map<string, number> = new Map();
  private lastTick: Map<string, { timestampMs: number; price: number }> = new Map();
  /** Tick counts for dynamic-slot eviction (least-ticked non-core first). */
  private tickCounts: Map<string, number> = new Map();
  /** Last REST momentum score attached at subscribe time (optional). */
  private dynamicMomentumScores: Map<string, number> = new Map();
  /** Wall-clock ms when each dynamic symbol was (re)subscribed. */
  private subscribedAtMs: Map<string, number> = new Map();
  /** Bounded, single-use eviction-immunity grants from requestTemporaryDataRescue() - never a
   *  permanent subscription; auto-expires and is swept by releaseExpiredTemporaryDataRescues().
   *  requestCount/extensionCount and traceId are purely observational (Phase 18) - never read by
   *  the admission decision itself, which depends on requestClass + intent + current occupancy
   *  (Phase 28 adds `intent`: the admission check below counts only NEW_DATA_ACQUISITION entries
   *  against the concurrent-rescue budget - a RENEWAL entry never competes for that budget). */
  private temporaryRescues: Map<string, {
    expiresAtMs: number;
    reason: string;
    requestClass: RescueRequestClass;
    intent: RescueIntent;
    traceId: string | null;
    grantedAtMs: number;
    requestCount: number;
    extensionCount: number;
  }> = new Map();
  /** When set (ibkr_gateway active), overrides Alpaca-safe cap from continuousIntelligence. */
  private hardCapOverride: number | null = null;
  private quoteBackend: MarketDataQuoteBackend = 'alpaca';
  private ibkrBridge: IbkrQuoteBridge | null = null;
  /** Optional frozen clock for dwell-unit tests. */
  private testNowMs: number | null = null;
  private lastRejectLogMs: Map<string, number> = new Map();
  /** Phase 28 (2026-09-02 P0 discovery fix): per-symbol dedup for the news-triggered discovery-
   *  lineage log below - reuses tradingSafety.marketDataRejectLogDedupMs (same cooldown constant
   *  lastRejectLogMs already uses) so a symbol re-requested many times in a short window logs one
   *  lineage entry, not one per attempt. */
  private lastNewsDiscoveryLogMs: Map<string, number> = new Map();
  /** Set via recordMarketDataError() (BrokerManager wires the IBKR bridge's real reqMktData
   *  rejections here — see IbkrSocketSession.ts's 2026-09-04 fix). Never set for Alpaca; that
   *  backend's failures already surface as reconnect/backoff logs. Purely observational: does not
   *  change subscription/eviction behavior, only makes an otherwise-silent per-symbol data-line
   *  rejection visible on getActiveSlots()/the /capacity endpoint. */
  private marketDataErrors: Map<string, { code: number; message: string; atMs: number }> = new Map();
  private disconnectedAt: number | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectBackoff = new ReconnectBackoff();
  private lastError: string | null = null;
  private authenticated = false;
  private watchlistListening = false;
  /** In-place recovery after Alpaca "symbol limit exceeded" — skip reconnect storm. */
  private symbolLimitRecoveryInFlight = false;
  private suppressReconnectUntilMs = 0;

  /** Effective hard cap — IB Gateway may raise this above Alpaca IEX limits. */
  private effectiveStreamingCap(): number {
    if (this.hardCapOverride != null && this.hardCapOverride > 0) return this.hardCapOverride;
    return defaultStreamingCap();
  }

  /**
   * Public planner cap for OpportunityDiscovery (and status).
   * IBKR Gateway: hardCapOverride from BrokerManager (typically 90).
   * Alpaca / default: continuousIntelligence.maxActiveSubscriptions (12).
   */
  getEffectiveStreamingCap(): number {
    return this.effectiveStreamingCap();
  }

  /**
   * Called by BrokerManager on active-broker switch.
   * ibkr_gateway: expand cap + route new subscriptions through reqMktData (no browser).
   * alpaca / ibkr_web: restore Alpaca IEX-safe cap.
   */
  setBrokerQuoteContext(opts: {
    backend: MarketDataQuoteBackend;
    hardCapOverride?: number | null;
    ibkrBridge?: IbkrQuoteBridge | null;
  }): void {
    const prevBackend = this.quoteBackend;
    if (prevBackend === 'ibkr_gateway' && opts.backend !== 'ibkr_gateway') {
      try { this.ibkrBridge?.clear(); } catch { /* ignore */ }
    }
    this.quoteBackend = opts.backend;
    this.hardCapOverride = opts.hardCapOverride ?? null;
    this.ibkrBridge = opts.ibkrBridge ?? null;
    console.log(
      `[MarketDataWorker] Quote backend=${this.quoteBackend} hardCap=${this.effectiveStreamingCap()}` +
        (this.ibkrBridge ? ' (IB Gateway reqMktData bridge on)' : ''),
    );
  }

  getQuoteBackend(): MarketDataQuoteBackend {
    return this.quoteBackend;
  }

  getLatestPrice(symbol: string): number | null {
    const key = quoteKey(symbol);
    if (!key) return null;
    return this.latestPrices.get(key) ?? this.latestPrices.get(symbol) ?? null;
  }

  /** Snapshot of the single IEX socket cache — InternalPaper.tick source of truth (no second WS). */
  getLatestPrices(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [symbol, price] of this.latestPrices) {
      if (typeof price === 'number' && Number.isFinite(price) && price > 0) out[symbol] = price;
    }
    return out;
  }

  getActiveSymbols(): string[] {
    return Array.from(this.activeStreams);
  }

  /** Permanently locked anchors (SPY/QQQ/GLD from config). */
  getCoreSymbols(): string[] {
    return Array.from(this.activeStreams).filter((s) => coreStreamingSet().has(s));
  }

  /** Non-anchor streaming slots (up to cap − core). */
  getDynamicSymbols(): string[] {
    const core = coreStreamingSet();
    return Array.from(this.activeStreams).filter((s) => !core.has(s));
  }

  getDynamicMomentumScore(symbol: string): number | null {
    const key = quoteKey(symbol);
    const v = this.dynamicMomentumScores.get(key);
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  getTickCount(symbol: string): number {
    return this.tickCounts.get(quoteKey(symbol)) ?? 0;
  }

  /** Test-only: freeze/advance wall clock for dwell checks. */
  setNowForTests(ms: number | null): void {
    this.testNowMs = ms;
  }

  private hasActiveRescue(symbol: string): boolean {
    const r = this.temporaryRescues.get(symbol);
    if (!r) return false;
    if (this.wallMs() >= r.expiresAtMs) {
      this.temporaryRescues.delete(symbol);
      return false;
    }
    return true;
  }

  /**
   * Phase 13 (2026-08-31 strategy-starvation remediation): a strategy's real, fully-constructed
   * idea (e.g. QuantEngine's cold-start bootstrap for MOMENTUM_BREAKOUT) can be discarded solely
   * because assessDataQuality(symbol).tradeBlocked is true for a symbol outside the actively-
   * streamed set - real, evidence-backed root cause traced in the Phase 13 audit (LNG/XOM winning
   * MOMENTUM_BREAKOUT's real selection 249 times, 0 real emissions, all blocked by
   * SYMBOL_NOT_SUBSCRIBED / STALE_MARKET_DATA). This grants that symbol a BOUNDED, single-use
   * eviction-immunity window so its NEXT evaluation cycle has a genuine chance at live data -
   * it never bypasses the CURRENT cycle's stale-data block (the caller's current idea is still
   * correctly discarded if data is stale right now), never fabricates a price, and never grows the
   * permanent subscription universe: the grant auto-expires (temporaryDataRescueMaxDurationMs) and
   * is swept by releaseExpiredTemporaryDataRescues() - after that it is exactly as evictable as any
   * other dynamic symbol, never specially retained.
   */
  /** Shared denial log - Phase 18: previously only the GRANT path logged anything; a denial
   *  (including the pre-existing RESCUE_CAPACITY_FULL/AT_CAPACITY_NO_SAFE_EVICTION cases) left no
   *  record at all, forcing the exact manual event-correlation the Phase 17 audit had to do by
   *  hand. Never mutates state - purely observational. */
  private logRescueDenial(
    ticker: string,
    reason: string,
    requestClass: RescueRequestClass,
    traceId: string | null,
    deniedReason: RescueDeniedReason,
    intent: RescueIntent,
  ): void {
    observeSafe(() => {
      structuredLogger.info('temporary_data_rescue_denied', {
        category: 'DISCOVERY',
        eventType: 'TEMPORARY_DATA_RESCUE_DENIED',
        symbol: ticker,
        traceId: traceId ?? undefined,
        // Phase 28: explicit fields (not just embedded in `reasoning`) so a future FRVO-class
        // incident is queryable without regex-parsing free text - "was this symbol already
        // subscribed / did it have any tick history at all" is exactly the distinction that took
        // manual event correlation to reconstruct for the real FRVO case.
        requestClass,
        requestIntent: intent,
        alreadySubscribed: this.activeStreams.has(ticker),
        hasFreshTick: this.lastTick.has(ticker),
        deniedReason,
        // [intent=...] is inserted BEFORE "denied:" so explorationHealthReport.ts's
        // /denied: (\S+)\.$/ extraction of the trailing denial reason keeps matching unchanged.
        reasoning: `${reason} [class=${requestClass}] [intent=${intent}] denied: ${deniedReason}.`,
      });
    });
  }

  requestTemporaryDataRescue(
    symbol: string,
    reason: string,
    opts: { requestClass?: RescueRequestClass; traceId?: string } = {},
  ): {
    granted: boolean; symbol: string; alreadySubscribed: boolean; evictedSymbol: string | null; deniedReason?: RescueDeniedReason;
  } {
    // Backward-compatible default (Invariant 9): any existing caller that does not pass opts (or
    // omits requestClass) is treated exactly as before this fix - a routine recovery request,
    // subject to the same admission rule that existed pre-Phase-18 once combined with the reserved
    // allowance below (reservedForPriorityClasses only ever narrows ROUTINE_RECOVERY's own ceiling,
    // it never changes behavior for a caller that always identified as ROUTINE_RECOVERY).
    const requestClass: RescueRequestClass = opts.requestClass ?? 'ROUTINE_RECOVERY';
    const traceId = opts.traceId ?? null;

    const ticker = looksLikeListedTicker(symbol) || quoteKey(symbol);
    if (!ticker) {
      const fallback = quoteKey(symbol);
      // Real subscription state is meaningless for an invalid symbol - NEW_DATA_ACQUISITION is the
      // honest default (there is no "existing subscription" to renew).
      this.logRescueDenial(fallback, reason, requestClass, traceId, 'INVALID_SYMBOL', 'NEW_DATA_ACQUISITION');
      return { granted: false, symbol: fallback, alreadySubscribed: false, evictedSymbol: null, deniedReason: 'INVALID_SYMBOL' };
    }

    // Real defect found live in production (2026-08-31, hours after this mechanism deployed):
    // a boot-time transient (every symbol briefly shows no tick age at all right after process
    // start) caused rescue GRANTS for QQQ/AAPL/TSLA - permanently protected/core symbols that were
    // never actually at eviction risk. Each grant consumed one of only
    // maxConcurrentTemporaryDataRescues slots, which could starve a genuinely at-risk symbol
    // (the real MOMENTUM_BREAKOUT case, e.g. LNG/XOM) out of a rescue during the same window.
    // A permanently protected symbol never needs eviction-immunity - it already has it
    // unconditionally - so this never touches the bounded rescue budget for it.
    if (protectedStreamingSet().has(ticker)) {
      return { granted: true, symbol: ticker, alreadySubscribed: this.activeStreams.has(ticker), evictedSymbol: null };
    }

    // Extending an already-active rescue (or one on an already-subscribed symbol) never evicts
    // anyone and never counts twice against the concurrent-rescue cap.
    const alreadyRescued = this.hasActiveRescue(ticker);
    const alreadySubscribed = this.activeStreams.has(ticker);
    const existing = this.temporaryRescues.get(ticker);

    // Phase 28 (2026-09-02 P0 discovery fix): real, current subscription state - never inferred
    // from requestClass or caller identity. A symbol already in activeStreams does not need a
    // fresh tick acquired; it only ever needs its eviction-immunity window extended (RENEWAL).
    const intent: RescueIntent = alreadySubscribed ? 'RENEWAL' : 'NEW_DATA_ACQUISITION';

    // The confirmed FRVO root cause: a RENEWAL request (already-subscribed AAPL/TSLA/ABNB
    // repeatedly re-extending immunity) must never compete for the SAME budget a genuine
    // NEW_DATA_ACQUISITION request (FRVO, no live tick at all) needs. RENEWAL is therefore
    // exempted from the concurrent-rescue-budget check entirely below - it is not "unlimited"
    // capacity: a RENEWAL request can only ever exist for a symbol already occupying one of the
    // hard-capped effectiveStreamingCap() active-stream slots, so it is already structurally
    // bounded by that pre-existing, unchanged cap. Do NOT increase maxConcurrentTemporaryDataRescues
    // to solve this - that would still let renewal-only traffic starve acquisition, just with a
    // larger shared pool. The correct fix is accounting separation, not more capacity.
    if (!alreadyRescued && intent === 'NEW_DATA_ACQUISITION') {
      const activeEntries = Array.from(this.temporaryRescues.entries())
        .filter(([s]) => this.hasActiveRescue(s))
        .filter(([, r]) => r.intent === 'NEW_DATA_ACQUISITION');
      // Invariant 3: capacity never exceeds the configured maximum, regardless of class.
      if (activeEntries.length >= continuousIntelligence.maxConcurrentTemporaryDataRescues) {
        this.logRescueDenial(ticker, reason, requestClass, traceId, 'RESCUE_CAPACITY_FULL', intent);
        return { granted: false, symbol: ticker, alreadySubscribed, evictedSymbol: null, deniedReason: 'RESCUE_CAPACITY_FULL' };
      }
      // Phase 18 fairness rule: a ROUTINE_RECOVERY request (the pre-existing, undifferentiated
      // case - e.g. a symbol whose idea is discarded by stale data on a normal, non-exploration
      // cycle) is additionally capped below the full pool, reserving rescueReservedSlotsForPriorityClasses
      // slots exclusively for EXPLORATION/MARKET_MOVER/NEWS_CATALYST requests. This is the entire
      // fix: it guarantees a bounded exploration/mover/news-catalyst opportunity even when routine
      // demand is high enough to otherwise consume every slot (the exact live-observed AAPL/TSLA/AI
      // pattern), without touching the hard total-capacity ceiling above, without preempting an
      // already-granted rescue, and without any new state beyond the requestClass already recorded.
      if (requestClass === 'ROUTINE_RECOVERY') {
        const routineCap = continuousIntelligence.maxConcurrentTemporaryDataRescues - continuousIntelligence.rescueReservedSlotsForPriorityClasses;
        const activeRoutineCount = activeEntries.filter(([, r]) => r.requestClass === 'ROUTINE_RECOVERY').length;
        if (activeRoutineCount >= routineCap) {
          this.logRescueDenial(ticker, reason, requestClass, traceId, 'ROUTINE_CAPACITY_RESERVED_FOR_PRIORITY', intent);
          return { granted: false, symbol: ticker, alreadySubscribed, evictedSymbol: null, deniedReason: 'ROUTINE_CAPACITY_RESERVED_FOR_PRIORITY' };
        }
      }
    }

    let evictedSymbol: string | null = null;
    if (!alreadySubscribed) {
      const cap = this.effectiveStreamingCap();
      if (this.activeStreams.size >= cap) {
        const candidate = this.pickEvictionCandidate();
        if (!candidate) {
          this.logRescueDenial(ticker, reason, requestClass, traceId, 'AT_CAPACITY_NO_SAFE_EVICTION', intent);
          return { granted: false, symbol: ticker, alreadySubscribed: false, evictedSymbol: null, deniedReason: 'AT_CAPACITY_NO_SAFE_EVICTION' };
        }
        this.unsubscribe(candidate, { force: false });
        evictedSymbol = candidate;
        observeSafe(() => {
          structuredLogger.info('subscription_priority_decision', {
            category: 'DISCOVERY',
            eventType: 'SUBSCRIPTION_EVICTED',
            symbol: candidate,
            reasoning: `Evicted to free one slot for a bounded temporary data rescue on ${ticker} (${reason}).`,
          });
        });
      }
      this.subscribe(ticker, { requestedBy: reason });
    }

    const expiresAtMs = this.wallMs() + Math.max(1, continuousIntelligence.temporaryDataRescueMaxDurationMs);
    this.temporaryRescues.set(ticker, {
      expiresAtMs,
      reason,
      requestClass,
      intent,
      traceId,
      grantedAtMs: existing?.grantedAtMs ?? this.wallMs(),
      requestCount: (existing?.requestCount ?? 0) + 1,
      extensionCount: (existing?.extensionCount ?? 0) + (alreadyRescued ? 1 : 0),
    });

    observeSafe(() => {
      structuredLogger.info('temporary_data_rescue_granted', {
        category: 'DISCOVERY',
        eventType: 'TEMPORARY_DATA_RESCUE_GRANTED',
        symbol: ticker,
        traceId: traceId ?? undefined,
        requestClass,
        requestIntent: intent,
        alreadySubscribed,
        hasFreshTick: this.lastTick.has(ticker),
        reasoning: `${reason} [class=${requestClass}] [intent=${intent}]${evictedSymbol ? ` - evicted ${evictedSymbol} for one rescue slot` : alreadySubscribed ? ' - already subscribed, only the eviction-immunity window was extended' : ''}. Expires in ${continuousIntelligence.temporaryDataRescueMaxDurationMs}ms; never a permanent subscription.`,
      });
    });

    return { granted: true, symbol: ticker, alreadySubscribed, evictedSymbol };
  }

  /** Read-only view for reports/tests - never mutates state. Phase 18: now exposes class,
   *  traceId, and request/extension counts so "who currently owns rescue capacity and why" is
   *  directly answerable without joining logs. Never exposes secrets/credentials/account data -
   *  every field here was already either public (symbol) or purely internal bookkeeping. */
  getActiveTemporaryRescues(): Array<{
    symbol: string;
    expiresAtMs: number;
    reason: string;
    requestClass: RescueRequestClass;
    intent: RescueIntent;
    traceId: string | null;
    grantedAtMs: number;
    requestCount: number;
    extensionCount: number;
  }> {
    return Array.from(this.temporaryRescues.entries())
      .filter(([s]) => this.hasActiveRescue(s))
      .map(([symbol, r]) => ({
        symbol,
        expiresAtMs: r.expiresAtMs,
        reason: r.reason,
        requestClass: r.requestClass,
        intent: r.intent,
        traceId: r.traceId,
        grantedAtMs: r.grantedAtMs,
        requestCount: r.requestCount,
        extensionCount: r.extensionCount,
      }));
  }

  /** Periodic sweep: a rescue past its bound stops being specially protected - it does not force
   *  an unsubscribe (something organic may have kept it useful in the meantime); it simply becomes
   *  exactly as evictable as any other dynamic symbol again, same as before the rescue. */
  releaseExpiredTemporaryDataRescues(): void {
    const now = this.wallMs();
    for (const [symbol, r] of Array.from(this.temporaryRescues.entries())) {
      if (now >= r.expiresAtMs) {
        this.temporaryRescues.delete(symbol);
        observeSafe(() => {
          structuredLogger.info('temporary_data_rescue_released', {
            category: 'DISCOVERY',
            eventType: 'TEMPORARY_DATA_RESCUE_RELEASED',
            symbol,
            reasoning: `Bounded rescue window elapsed (${r.reason}) - no longer specially protected from eviction.`,
          });
        });
      }
    }
  }

  private wallMs(): number {
    return this.testNowMs ?? Date.now();
  }

  getSubscribedAtMs(symbol: string): number | null {
    const v = this.subscribedAtMs.get(quoteKey(symbol));
    return typeof v === 'number' ? v : null;
  }

  /**
   * Records a real per-symbol market-data rejection (currently: IBKR reqMktData errors relayed
   * from IbkrSocketSession via BrokerManager). Read-only bookkeeping — never evicts, never
   * un-subscribes, never touches OMS/RiskEngine. Exists so a symbol that looks "active" but is
   * silently receiving zero ticks (the confirmed 2026-09-04 NVDA-class defect) is diagnosable
   * instead of looking like an unexplained data gap.
   */
  recordMarketDataError(symbol: string, code: number, message: string): void {
    const sym = quoteKey(symbol);
    if (!sym) return;
    this.marketDataErrors.set(sym, { code, message, atMs: this.wallMs() });
  }

  getMarketDataError(symbol: string): { code: number; message: string; atMs: number } | null {
    return this.marketDataErrors.get(quoteKey(symbol)) ?? null;
  }

  /**
   * Operator/forensic view of the streamed set (anchors first, then dynamics). Cap is whatever
   * getEffectiveStreamingCap() currently reports (12 Alpaca-safe default, ~90 under IBKR Gateway's
   * hardCapOverride) — not a fixed 12. Does not emit events or mutate subscriptions.
   */
  getActiveSlots(): Array<{
    slot: number;
    symbol: string;
    type: 'ANCHOR' | 'DYNAMIC';
    score: number;
    dwellAgeMs: number;
    tickCount: number;
    marketDataError: { code: number; message: string; atMs: number } | null;
  }> {
    const core = coreStreamingSet();
    const now = this.wallMs();
    const ordered = [
      ...Array.from(this.activeStreams).filter((s) => core.has(s)).sort(),
      ...Array.from(this.activeStreams).filter((s) => !core.has(s)).sort(),
    ];
    return ordered.map((symbol, idx) => {
      const subscribedAt = this.subscribedAtMs.get(symbol) ?? now;
      return {
        slot: idx + 1,
        symbol,
        type: core.has(symbol) ? 'ANCHOR' as const : 'DYNAMIC' as const,
        score: this.dynamicMomentumScores.get(symbol) ?? 0,
        dwellAgeMs: Math.max(0, now - subscribedAt),
        tickCount: this.tickCounts.get(symbol) ?? 0,
        marketDataError: this.marketDataErrors.get(symbol) ?? null,
      };
    });
  }

  private isWithinDynamicDwell(symbol: string): boolean {
    const dwellMs = continuousIntelligence.minDynamicDwellMs;
    const dwellTicks = continuousIntelligence.minDynamicDwellTicks;
    const ticks = this.tickCounts.get(symbol) ?? 0;
    if (ticks >= dwellTicks) return false;
    const subscribedAt = this.subscribedAtMs.get(symbol);
    if (subscribedAt == null) return false;
    return this.wallMs() - subscribedAt < dwellMs;
  }

  getLatestPriceAgeMs(symbol: string): number | null {
    const key = quoteKey(symbol);
    const t = this.latestPriceTimestamps.get(key) ?? this.latestPriceTimestamps.get(symbol);
    if (typeof t !== 'number') return null;
    // Real, live-reproduced defect found and removed (Phase 14 historical-replay mission,
    // 2026-08-31): this used to attempt `require('../replay/ReplayContext')` to substitute a
    // replay's simulated clock for real wall-clock time - `require` does not exist in this
    // server's ESM runtime ("require is not defined", confirmed live against a real running
    // replay), so the surrounding try/catch silently swallowed that error on every single call and
    // always fell through to the line below anyway. Removing the dead branch changes nothing
    // observable - it was already a no-op - and is correct architecturally too:
    // HistoricalReplayMarketDataContext.ts's own header states it "never mutates MarketDataWorker
    // live state", using a fully separate, isolated quote cache (cacheReplayQuote/
    // getReplayQuoteAgeMs) with the replay's own simulated clock passed in explicitly - this live
    // function was never the real path replay relies on for price-age freshness.
    return Date.now() - t;
  }

  /** Real ask price from the last "q" message that carried one, or null if none has ever arrived
   *  for this symbol. Never fabricated from the bid price or any other proxy. */
  getLatestAsk(symbol: string): number | null {
    const key = quoteKey(symbol);
    return this.latestAskPrices.get(key) ?? this.latestAskPrices.get(symbol) ?? null;
  }

  /**
   * Real bid/ask spread in basis points, computed only when BOTH a bid (latestPrices) and an ask
   * (latestAskPrices) exist AND the ask observation is no older than maxAgeMs relative to now -
   * a bid from 4pm paired with an ask from 9am would be a fabricated spread, not a real one. Returns
   * null (never a fabricated 0 or a stale number) when either side is missing or the ask is stale.
   */
  getLatestSpreadBps(symbol: string, maxAgeMs: number): number | null {
    const key = quoteKey(symbol);
    const bid = this.latestPrices.get(key) ?? this.latestPrices.get(symbol);
    const ask = this.latestAskPrices.get(key) ?? this.latestAskPrices.get(symbol);
    const askAt = this.latestAskTimestamps.get(key) ?? this.latestAskTimestamps.get(symbol);
    if (typeof bid !== 'number' || typeof ask !== 'number' || typeof askAt !== 'number') return null;
    if (Date.now() - askAt > maxAgeMs) return null;
    if (!(bid > 0) || !(ask > 0) || ask < bid) return null;
    const mid = (bid + ask) / 2;
    return mid > 0 ? ((ask - bid) / mid) * 10_000 : null;
  }

  /**
   * Record an observed quote for freshness/sizing without a WebSocket session.
   * Does not emit MARKET_DATA (no idea-agent warmup). Tests and InternalPaper must not invent
   * broker fills here.
   */
  cacheObservedQuote(symbol: string, price: number, observedAtMs: number = Date.now()): void {
    const sym = quoteKey(symbol);
    if (!sym || !Number.isFinite(price) || price <= 0) return;
    this.latestPrices.set(sym, price);
    this.latestPriceTimestamps.set(sym, observedAtMs);
  }

  /** IB Gateway Level-1 tick → same cache + EventBus path as Alpaca IEX (OMS/RiskEngine unchanged). */
  ingestIbkrQuote(symbol: string, price: number): void {
    const sym = quoteKey(symbol);
    if (!sym || !Number.isFinite(price) || price <= 0) return;
    const now = Date.now();
    if (!this.acceptTickTimestamp(sym, now, price)) return;
    this.tickCounts.set(sym, (this.tickCounts.get(sym) || 0) + 1);
    this.latestPrices.set(sym, price);
    this.latestPriceTimestamps.set(sym, now);
    this.maybeEmitMarketData(sym, price, 0, new Date(now).toISOString());
  }

  /**
   * Real bug found and fixed (2026-08-25 readiness audit, Phase 3): for the IBKR Gateway backend
   * this previously returned `activeStreams.size > 0 || this.authenticated` - a purely local
   * bookkeeping check, since nothing on this class ever sets `this.authenticated` for the IBKR
   * path (that flag is only ever touched by the Alpaca WebSocket handlers below). Once at least
   * one symbol had ever been successfully subscribed, `activeStreams.size > 0` stayed true
   * forever, even after the real underlying IB Gateway socket disconnected later - confirmed live
   * (10 symbols "active" per this worker's own bookkeeping while `./argus health` simultaneously
   * reported `ibkrPaths.gatewaySocket.status: OFFLINE` and `activeMarketDataLines: 0`). Health/
   * session-report kept reporting "Market Data: READY" indefinitely after a real disconnect,
   * which is exactly the kind of false-positive readiness signal this audit pass is fixing
   * elsewhere (see TradingReadinessGate.ts). Now defers to the bridge's own real connectivity
   * check when the bridge provides one; falls back to the old heuristic only if it doesn't
   * (existing tests construct a bridge-less ibkr_gateway context, where this branch never runs
   * anyway since `this.ibkrBridge` is null there).
   */
  isConnected(): boolean {
    if (this.quoteBackend === 'ibkr_gateway' && this.ibkrBridge) {
      if (typeof this.ibkrBridge.isConnected === 'function') return this.ibkrBridge.isConnected();
      return this.activeStreams.size > 0 || this.authenticated;
    }
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  getFeedStatus(): {
    connected: boolean;
    readyState: number | null;
    authenticated: boolean;
    lastError: string | null;
    symbols: string[];
    streamingCap: number;
  } {
    return {
      connected: this.isConnected(),
      readyState: this.ws ? this.ws.readyState : null,
      authenticated: this.authenticated,
      lastError: this.lastError,
      symbols: this.getActiveSymbols(),
      streamingCap: this.effectiveStreamingCap(),
    };
  }

  private maybeEmitMarketData(symbol: string, price: number, volume: number, timestamp: string) {
    // Piggybacks on the real tick cadence (cheap - temporaryRescues is bounded by
    // maxConcurrentTemporaryDataRescues) rather than a dedicated timer; runs regardless of the
    // Autobot-gated early return just below, since a rescue's bounded expiry must not depend on
    // whether Autobot happens to be on for whichever OTHER symbol just ticked.
    if (this.temporaryRescues.size > 0) this.releaseExpiredTemporaryDataRescues();
    // Always cache the last quote for RiskEngine/UI freshness (callers write latestPrices
    // before this). Emit MARKET_DATA only while Autobot is on and tradingState is
    // TRADING_ENABLED — otherwise tick-driven idea agents would keep warming from Autobot-off
    // quotes. Do not use the interrupted-session *entry* hold here: inventory SELL still
    // needs live prices, and idea agents apply their own separate entry-idea gate downstream
    // (see src/server/core/ideaGenerationGate.ts) rather than relying on this tick emission.
    if (!isAutobotTradingEnabled()) return;
    eventBus.emitMarketData(symbol, price, volume, timestamp);
    // Tick-driven agents stay IDLE until MARKET_DATA resumes; nudge heartbeats so CLI/UI
    // show RUNNING as soon as the feed is healthy again (agents still process the event).
    notePipelineAgentTick('TechnicalAgent');
    notePipelineAgentTick('KronosEngine');
  }

  private isDuplicateTick(symbol: string, timestampMs: number, price: number): boolean {
    const last = this.lastTick.get(quoteKey(symbol));
    return !!last && last.timestampMs === timestampMs && last.price === price;
  }

  /** Reject future / stale-reorder ticks. Does not bypass RiskEngine data_freshness. */
  private acceptTickTimestamp(symbol: string, timestampMs: number, price: number): boolean {
    const now = Date.now();
    if (!Number.isFinite(timestampMs)) {
      this.rejectTick(symbol, 'INVALID_TIMESTAMP', { timestampMs, price });
      return false;
    }
    if (timestampMs > now + tradingSafety.tickFutureSkewMs) {
      this.rejectTick(symbol, 'FUTURE_TIMESTAMP', { timestampMs, now, skewMs: timestampMs - now, price });
      return false;
    }
    const last = this.lastTick.get(quoteKey(symbol));
    if (last && timestampMs < last.timestampMs - tradingSafety.tickOutOfOrderEpsilonMs) {
      this.rejectTick(symbol, 'OUT_OF_ORDER', {
        timestampMs, lastAcceptedMs: last.timestampMs, lagMs: last.timestampMs - timestampMs, price,
      });
      return false;
    }
    return true;
  }

  private rejectTick(symbol: string, reason: string, detail: Record<string, unknown>): void {
    const key = `${symbol}|${reason}`;
    const now = Date.now();
    const lastLog = this.lastRejectLogMs.get(key) ?? 0;
    if (now - lastLog < tradingSafety.marketDataRejectLogDedupMs) return;
    this.lastRejectLogMs.set(key, now);
    eventBus.emit(EVENTS.MARKET_DATA_REJECTED, { symbol, reason, ...detail });
  }

  start() {
    this.ensureWatchlistListener();
    if (!isMarketDataWebSocketAuthorized()) {
      console.warn(
        '[MarketDataWorker] Refusing Alpaca IEX WebSocket — not authorized for this process '
        + '(CLI/soak/orphan imports must not open a parallel stream). Primary server/engine only.',
      );
      this.lastError = 'MARKET_DATA_WS_NOT_AUTHORIZED';
      return;
    }
    if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
      console.log("[MarketDataWorker] No Alpaca keys provided. MarketDataWorker will idle in disconnected state without fabricating data.");
      eventBus.emit(EVENTS.MARKET_DATA_DISCONNECTED, { reason: "Missing API keys" });
      return;
    }
    const state = this.ws?.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;
    this.connectAlpaca();
  }

  /** Diagnostics retry: tear down a dead socket and handshake again. Never bypasses RiskEngine. */
  reconnect(): ReturnType<MarketDataWorker['getFeedStatus']> {
    this.clearReconnectTimer();
    this.reconnectBackoff.reset();
    this.tearDownSocket();
    if (!isMarketDataWebSocketAuthorized()) {
      this.lastError = 'MARKET_DATA_WS_NOT_AUTHORIZED';
      return this.getFeedStatus();
    }
    if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
      this.lastError = 'ALPACA_API_KEY or ALPACA_SECRET_KEY unset';
      eventBus.emit(EVENTS.MARKET_DATA_DISCONNECTED, { reason: "Missing API keys" });
      return this.getFeedStatus();
    }
    this.connectAlpaca();
    return this.getFeedStatus();
  }

  stop() {
    this.clearReconnectTimer();
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.tearDownSocket();
    console.log("[MarketDataWorker] Disconnected.");
  }

  /**
   * @param opts.requestedBy - real fix (2026-08-24 readiness audit, Part 2): FundamentalAgent/
   * MacroAgent/NewsEngine round-robin through the full idea universe (~122 symbols) but never
   * requested coverage for their own evaluation target - they only ever passively called
   * getLatestPrice() and hoped the symbol happened to already be streamed for some unrelated
   * reason (opportunity-discovery priority). With only 18-90 of the universe actually streamed at
   * once, most round-robin picks had no live tick at all - this was the deterministic, traceable
   * cause of most MISSING_PRICE rejections. Passing requestedBy lets this call site show up in the
   * new SYMBOL_NOT_SUBSCRIBED/MARKET_DATA_CAPACITY_FULL observability below.
   */
  subscribe(symbol: string, opts: { momentumScore?: number; requestedBy?: string } = {}) {
    const ticker = looksLikeListedTicker(symbol);
    if (!ticker) return;
    if (this.activeStreams.has(ticker)) {
      if (typeof opts.momentumScore === 'number' && Number.isFinite(opts.momentumScore)) {
        this.dynamicMomentumScores.set(ticker, opts.momentumScore);
      }
      return;
    }
    if (opts.requestedBy) {
      eventBus.emit(EVENTS.SYMBOL_NOT_SUBSCRIBED, { symbol: ticker, requestedBy: opts.requestedBy, at: new Date().toISOString() });
      this.logNewsDiscoveryLineageIfCatalystBacked(ticker);
    }

    const cap = this.effectiveStreamingCap();
    if (this.activeStreams.size >= cap) {
      this.pruneLeastActiveWatchSymbols(1);
    }
    if (this.activeStreams.size >= cap) {
      console.warn(
        `[MarketDataWorker] Refusing subscribe ${ticker} — at hard cap ${cap} (protected/core symbols retained)`,
      );
      if (opts.requestedBy) {
        eventBus.emit(EVENTS.MARKET_DATA_CAPACITY_FULL, { symbol: ticker, requestedBy: opts.requestedBy, cap, active: this.activeStreams.size, at: new Date().toISOString() });
      }
      return;
    }

    this.activeStreams.add(ticker);
    this.subscribedAtMs.set(ticker, this.wallMs());
    this.tickCounts.set(ticker, 0);
    if (typeof opts.momentumScore === 'number' && Number.isFinite(opts.momentumScore)) {
      this.dynamicMomentumScores.set(ticker, opts.momentumScore);
    }
    if (this.quoteBackend === 'ibkr_gateway' && this.ibkrBridge) {
      try {
        this.ibkrBridge.subscribe(ticker);
      } catch (e: any) {
        console.warn(`[MarketDataWorker] IB Gateway subscribe ${ticker} failed: ${e?.message || e}`);
        this.activeStreams.delete(ticker);
        this.subscribedAtMs.delete(ticker);
        return;
      }
      console.log(`[MarketDataWorker] IB Gateway subscribed ${ticker} (${this.activeStreams.size}/${cap})`);
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Wire unsubscribe for any just-pruned names happens inside prune/unsubscribe before this send.
      this.ws.send(JSON.stringify({ action: "subscribe", quotes: [ticker], trades: [ticker] }));
    }
    console.log(`[MarketDataWorker] Subscribed to ${ticker} (${this.activeStreams.size}/${cap})`);
  }

  /**
   * Phase 28 (2026-09-02 P0 discovery fix), Discovery Lineage extension. The real FRVO incident
   * (2026-09-01) entered ARGUS through exactly this path - a news-driven agent (NewsAgent/
   * MacroAgent/FundamentalAgent) requesting a price snapshot for a symbol with no active
   * subscription - and that entry was previously invisible to the Discovery Lineage Ledger
   * (candidate_rankings / DISCOVERY_CANDIDATE_ADMITTED), which only ever saw BROAD_UNIVERSE/
   * MARKET_MOVER admissions. Extends the SAME existing ledger (logDiscoveryCandidateDecision(),
   * previously private to MarketUniverseScanner.ts, now shared) rather than creating a second one.
   *
   * Only logs when real catalyst evidence exists (NewsCatalystStore.hasRealCatalystEvidence(),
   * the exact same reviewed strength/bias bar used for NEWS_CATALYST rescue priority) - a routine
   * FundamentalAgent/MacroAgent round-robin price check on an already-known seed/watch symbol is
   * NOT itself a "discovery" event and must not be logged as one. Deduped per symbol using the
   * same tradingSafety.marketDataRejectLogDedupMs cooldown lastRejectLogMs already uses, so one
   * real news-driven entry does not become dozens of duplicate lineage rows across repeated
   * agent re-attempts on the same still-unsubscribed symbol.
   */
  private logNewsDiscoveryLineageIfCatalystBacked(ticker: string): void {
    if (!hasRealCatalystEvidence(ticker)) return;
    const now = this.wallMs();
    const lastLog = this.lastNewsDiscoveryLogMs.get(ticker) ?? 0;
    if (now - lastLog < tradingSafety.marketDataRejectLogDedupMs) return;
    this.lastNewsDiscoveryLogMs.set(ticker, now);
    logDiscoveryCandidateDecision({ symbol: ticker, source: 'NEWS', admitted: true, reason: null });
  }

  /**
   * Shared eviction ranking: lowest momentum/ticks/recency first, excluding protected core
   * symbols, dwell-protected fresh symbols, AND symbols currently holding an active temporary
   * data rescue (Phase 13) - a rescue grant must never be immediately undone by the very next
   * unrelated prune, or it would not actually give the strategy its one bounded chance at live data.
   */
  private rankEvictionCandidates(): Array<{ symbol: string; momentumScore: number; ticks: number; lastMs: number }> {
    const protectedSet = protectedStreamingSet();
    return Array.from(this.activeStreams)
      .filter((s) => !protectedSet.has(s))
      .filter((s) => !this.isWithinDynamicDwell(s))
      .filter((s) => !this.hasActiveRescue(s))
      .map((s) => ({
        symbol: s,
        momentumScore: this.dynamicMomentumScores.get(s) ?? 0,
        ticks: this.tickCounts.get(s) ?? 0,
        lastMs:
          this.latestPriceTimestamps.get(s)
          ?? this.lastTick.get(s)?.timestampMs
          ?? 0,
      }))
      .sort((a, b) => {
        if (a.momentumScore !== b.momentumScore) return a.momentumScore - b.momentumScore;
        if (a.ticks !== b.ticks) return a.ticks - b.ticks;
        return a.lastMs - b.lastMs;
      });
  }

  /** Query-only: the next symbol pruneLeastActiveWatchSymbols would evict, without evicting it. */
  private pickEvictionCandidate(): string | null {
    return this.rankEvictionCandidates()[0]?.symbol ?? null;
  }

  /**
   * Drop least-scored / least-ticked non-protected watch symbols so new candidates can join
   * without exceeding Alpaca IEX subscription limits (symbol limit exceeded).
   * Always sends Alpaca unsubscribe on the open socket before the caller may subscribe.
   * Core anchors (protectedSymbols / coreStreamingSymbols) are never evicted here.
   * Unscored dynamics rank as score 0 (not +Infinity). Fresh dwell-protected symbols are skipped.
   */
  private pruneLeastActiveWatchSymbols(needed: number = 1): void {
    if (needed <= 0) return;
    const ranked = this.rankEvictionCandidates();

    let removed = 0;
    for (const row of ranked) {
      if (removed >= needed) break;
      this.unsubscribe(row.symbol, { force: false });
      removed += 1;
      const reason = `Lowest-ranked non-protected dynamic symbol (score=${row.momentumScore.toFixed(3)}, ticks=${row.ticks}) - evicted to stay within cap ${this.effectiveStreamingCap()}.`;
      console.warn(`[MarketDataWorker] Pruned dynamic watch symbol ${row.symbol} - ${reason}`);
      // Phase 4D (Dynamic Subscription Priority Queue, 2026-08-26): the eviction RULE above is
      // unchanged (same score/ticks/recency ranking, same dwell protection already applied via
      // the `ranked` filter above) - this only makes the decision queryable after the fact
      // (GET /api/v2/discovery/subscription-events), answering "why did symbol Y lose its slot".
      observeSafe(() => {
        structuredLogger.info('subscription_priority_decision', {
          category: 'DISCOVERY',
          eventType: 'SUBSCRIPTION_EVICTED',
          symbol: row.symbol,
          reasoning: reason,
        });
      });
    }
  }

  /**
   * @param force — allow removing protected symbols (symbol-limit recovery only).
   */
  unsubscribe(symbol: string, opts: { force?: boolean } = {}) {
    const ticker = looksLikeListedTicker(symbol) || String(symbol || '').trim().toUpperCase();
    if (!ticker) return;
    if (!opts.force && protectedStreamingSet().has(ticker)) return;
    if (!this.activeStreams.has(ticker)) return;
    this.activeStreams.delete(ticker);
    this.dynamicMomentumScores.delete(ticker);
    this.tickCounts.delete(ticker);
    this.subscribedAtMs.delete(ticker);
    this.marketDataErrors.delete(ticker);
    if (this.quoteBackend === 'ibkr_gateway' && this.ibkrBridge) {
      try { this.ibkrBridge.unsubscribe(ticker); } catch { /* ignore */ }
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: "unsubscribe", quotes: [ticker], trades: [ticker] }));
    }
  }

  /**
   * Alpaca IEX "symbol limit exceeded": shrink to coreStreamingSymbols, unsubscribe extras
   * on the wire, resubscribe core — do not enter a rapid reconnect loop with the oversized set.
   */
  private recoverFromSymbolLimitExceeded(socket: WebSocket | null): void {
    if (this.symbolLimitRecoveryInFlight) return;
    this.symbolLimitRecoveryInFlight = true;
    this.suppressReconnectUntilMs = Date.now() + 15_000;
    try {
      const core = Array.from(coreStreamingSet()).slice(0, this.effectiveStreamingCap());
      const coreSet = new Set(core);
      const toDrop = Array.from(this.activeStreams).filter((s) => !coreSet.has(s));
      console.warn(
        `[MarketDataWorker] Symbol limit exceeded — purging ${toDrop.length} non-core subscription(s); `
        + `retaining core [${core.join(', ')}]`,
      );
      for (const sym of toDrop) {
        this.unsubscribe(sym, { force: true });
      }
      this.activeStreams = new Set(core);
      const live = socket && socket.readyState === WebSocket.OPEN ? socket : this.ws;
      if (live && live.readyState === WebSocket.OPEN && core.length > 0) {
        live.send(JSON.stringify({ action: 'subscribe', quotes: core, trades: core }));
      }
      this.lastError = 'symbol limit exceeded (recovered to coreStreamingSymbols)';
      eventBus.emit(EVENTS.MARKET_DATA_DISCONNECTED, {
        reason: 'symbol_limit_exceeded_recovered',
        retained: core,
        purged: toDrop,
      });
      // Avoid reconnect storm: clear pending reconnect while we recover in place.
      this.clearReconnectTimer();
      this.reconnectBackoff.reset();
    } finally {
      this.symbolLimitRecoveryInFlight = false;
    }
  }

  private ensureWatchlistListener() {
    if (this.watchlistListening) return;
    this.watchlistListening = true;
    eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, (payload: {
      symbol?: string;
      momentumScore?: number;
    }) => {
      this.subscribe(payload?.symbol || '', {
        momentumScore: typeof payload?.momentumScore === 'number' ? payload.momentumScore : undefined,
      });
    });
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private tearDownSocket() {
    const socket = this.ws;
    this.ws = null;
    this.authenticated = false;
    if (!socket) return;
    socket.removeAllListeners();
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    } catch {
      /* already dead */
    }
  }

  private ensureDefaultSubscriptions() {
    for (const s of defaultSubscribeSymbols(this.effectiveStreamingCap())) {
      const ticker = looksLikeListedTicker(s) || quoteKey(s);
      if (ticker) this.activeStreams.add(ticker);
    }
    while (this.activeStreams.size > this.effectiveStreamingCap()) {
      this.pruneLeastActiveWatchSymbols(1);
    }
  }

  private sendSubscribe(socket: WebSocket) {
    this.ensureDefaultSubscriptions();
    // Hard ceiling — never push more quotes than the configured Alpaca-safe cap.
    while (this.activeStreams.size > this.effectiveStreamingCap()) {
      this.pruneLeastActiveWatchSymbols(1);
    }
    // If still over (all protected), fall back to core only.
    if (this.activeStreams.size > this.effectiveStreamingCap()) {
      this.activeStreams = new Set(Array.from(coreStreamingSet()).slice(0, this.effectiveStreamingCap()));
    }
    const symbols = Array.from(this.activeStreams);
    if (symbols.length === 0) {
      console.warn('[MarketDataWorker] Authenticated but no symbols to subscribe (coreStreamingSymbols empty).');
      return;
    }
    socket.send(JSON.stringify({ action: 'subscribe', quotes: symbols, trades: symbols }));
  }

  private scheduleReconnect(reason: string) {
    if (Date.now() < this.suppressReconnectUntilMs) {
      console.log(`[MarketDataWorker] Suppressing reconnect (${reason}) during symbol-limit recovery window`);
      return;
    }
    if (this.reconnectTimer) return;
    const delayMs = this.reconnectBackoff.nextDelayMs();
    console.log(`[MarketDataWorker] Scheduling reconnect in ${delayMs}ms (${reason})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectAlpaca();
    }, delayMs);
  }

  private connectAlpaca() {
    if (!isMarketDataWebSocketAuthorized()) {
      this.lastError = 'MARKET_DATA_WS_NOT_AUTHORIZED';
      return;
    }
    this.clearReconnectTimer();
    const url = process.env.ALPACA_DATA_STREAM_URL || DEFAULT_STREAM_URL;
    console.log(`[MarketDataWorker] Connecting to Alpaca market-data WebSocket (${url})...`);
    const socket = new WebSocket(url, alpacaWebSocketTlsOptions());
    this.ws = socket;
    this.authenticated = false;

    socket.on("open", () => {
      if (this.ws !== socket) return;
      this.lastError = null;
      socket.send(JSON.stringify({
        action: "auth",
        key: process.env.ALPACA_API_KEY,
        secret: process.env.ALPACA_SECRET_KEY
      }));
    });

    socket.on("message", (data) => {
      if (this.ws !== socket) return;
      let messages: any[];
      try {
        const parsed = JSON.parse(data.toString());
        messages = Array.isArray(parsed) ? parsed : [parsed];
      } catch (e: any) {
        this.lastError = `Invalid JSON from feed: ${e.message}`;
        return;
      }
      for (const msg of messages) {
        if (msg.T === "success" && msg.msg === "authenticated") {
          this.authenticated = true;
          this.lastError = null;
          this.reconnectBackoff.reset();
          this.sendSubscribe(socket);
          if (this.disconnectedAt !== null) {
            const gapMs = Date.now() - this.disconnectedAt;
            console.warn(`[MarketDataWorker] Reconnected after a ${Math.round(gapMs / 1000)}s data gap - any ticks during that window were not received (no tick-level backfill source exists).`);
            eventBus.emit(EVENTS.MARKET_DATA_GAP_DETECTED, { gapMs, disconnectedAt: this.disconnectedAt, reconnectedAt: Date.now() });
            this.disconnectedAt = null;
          }
        } else if (msg.T === "error") {
          this.lastError = String(msg.msg || msg.code || 'Alpaca feed error');
          console.error(`[MarketDataWorker] Feed error: ${this.lastError}`);
          if (/symbol limit exceeded/i.test(this.lastError)) {
            this.recoverFromSymbolLimitExceeded(socket);
            continue;
          }
          eventBus.emit(EVENTS.MARKET_DATA_DISCONNECTED, { reason: this.lastError });
        } else if (msg.T === "q") {
          const sym = quoteKey(msg.S);
          if (!sym) continue;
          const timestampMs = new Date(msg.t).getTime();
          if (this.isDuplicateTick(sym, timestampMs, msg.bp)) continue;
          if (!this.acceptTickTimestamp(sym, timestampMs, msg.bp)) continue;
          this.lastTick.set(sym, { timestampMs, price: msg.bp });
          this.latestPrices.set(sym, msg.bp);
          this.latestPriceTimestamps.set(sym, Date.now());
          // Additive only - never gates isDuplicateTick/acceptTickTimestamp/maybeEmitMarketData
          // above, all of which stay keyed on the bid price exactly as before this field existed.
          if (typeof msg.ap === 'number' && Number.isFinite(msg.ap) && msg.ap > 0) {
            this.latestAskPrices.set(sym, msg.ap);
            this.latestAskTimestamps.set(sym, Date.now());
          }
          this.tickCounts.set(sym, (this.tickCounts.get(sym) ?? 0) + 1);
          if (this.lastError && /symbol limit exceeded/i.test(this.lastError)) {
            this.lastError = null;
          }
          this.maybeEmitMarketData(sym, msg.bp, msg.bs, new Date(msg.t).toISOString());
        } else if (msg.T === "t") {
          const sym = quoteKey(msg.S);
          if (!sym) continue;
          const timestampMs = new Date(msg.t).getTime();
          if (this.isDuplicateTick(sym, timestampMs, msg.p)) continue;
          if (!this.acceptTickTimestamp(sym, timestampMs, msg.p)) continue;
          this.lastTick.set(sym, { timestampMs, price: msg.p });
          this.latestPrices.set(sym, msg.p);
          this.latestPriceTimestamps.set(sym, Date.now());
          this.tickCounts.set(sym, (this.tickCounts.get(sym) ?? 0) + 1);
          if (this.lastError && /symbol limit exceeded/i.test(this.lastError)) {
            this.lastError = null;
          }
          this.maybeEmitMarketData(sym, msg.p, msg.s, new Date(msg.t).toISOString());
        }
      }
    });

    socket.on("error", (err) => {
      if (this.ws !== socket) return;
      this.lastError = err?.message || String(err);
      console.error("[MarketDataWorker] WebSocket error:", err);
      if (this.disconnectedAt === null) this.disconnectedAt = Date.now();
      eventBus.emit(EVENTS.MARKET_DATA_DISCONNECTED, { reason: this.lastError });
      this.scheduleReconnect('socket error');
    });

    socket.on("close", () => {
      if (this.ws !== socket) return;
      this.authenticated = false;
      this.ws = null;
      if (this.disconnectedAt === null) this.disconnectedAt = Date.now();
      console.log("[MarketDataWorker] WebSocket closed. Reconnecting...");
      eventBus.emit(EVENTS.MARKET_DATA_DISCONNECTED, { reason: this.lastError || "socket closed" });
      this.scheduleReconnect('socket closed');
    });
  }

}
export const marketDataWorker = new MarketDataWorker();

import { setTradeIdeaLivePriceLookup } from '../core/tradeIdeaContract';
setTradeIdeaLivePriceLookup((symbol) => marketDataWorker.getLatestPrice(symbol));
