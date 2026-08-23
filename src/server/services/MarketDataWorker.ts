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

const DEFAULT_STREAM_URL = 'wss://stream.data.alpaca.markets/v2/iex';

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
  private lastTick: Map<string, { timestampMs: number; price: number }> = new Map();
  /** Tick counts for dynamic-slot eviction (least-ticked non-core first). */
  private tickCounts: Map<string, number> = new Map();
  /** Last REST momentum score attached at subscribe time (optional). */
  private dynamicMomentumScores: Map<string, number> = new Map();
  /** Wall-clock ms when each dynamic symbol was (re)subscribed. */
  private subscribedAtMs: Map<string, number> = new Map();
  /** When set (ibkr_gateway active), overrides Alpaca-safe cap from continuousIntelligence. */
  private hardCapOverride: number | null = null;
  private quoteBackend: MarketDataQuoteBackend = 'alpaca';
  private ibkrBridge: IbkrQuoteBridge | null = null;
  /** Optional frozen clock for dwell-unit tests. */
  private testNowMs: number | null = null;
  private lastRejectLogMs: Map<string, number> = new Map();
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

  private wallMs(): number {
    return this.testNowMs ?? Date.now();
  }

  getSubscribedAtMs(symbol: string): number | null {
    const v = this.subscribedAtMs.get(quoteKey(symbol));
    return typeof v === 'number' ? v : null;
  }

  /**
   * Operator/forensic view of the 12-slot stream (anchors first, then dynamics).
   * Does not emit events or mutate subscriptions.
   */
  getActiveSlots(): Array<{
    slot: number;
    symbol: string;
    type: 'ANCHOR' | 'DYNAMIC';
    score: number;
    dwellAgeMs: number;
    tickCount: number;
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
    try {
      const { getActiveReplaySession } = require('../replay/ReplayContext');
      const replay = getActiveReplaySession();
      if (replay) return Math.max(0, replay.clock.now() - t);
    } catch { /* replay module optional during early boot */ }
    return Date.now() - t;
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

  isConnected(): boolean {
    if (this.quoteBackend === 'ibkr_gateway' && this.ibkrBridge) {
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

  subscribe(symbol: string, opts: { momentumScore?: number } = {}) {
    const ticker = looksLikeListedTicker(symbol);
    if (!ticker) return;
    if (this.activeStreams.has(ticker)) {
      if (typeof opts.momentumScore === 'number' && Number.isFinite(opts.momentumScore)) {
        this.dynamicMomentumScores.set(ticker, opts.momentumScore);
      }
      return;
    }

    const cap = this.effectiveStreamingCap();
    if (this.activeStreams.size >= cap) {
      this.pruneLeastActiveWatchSymbols(1);
    }
    if (this.activeStreams.size >= cap) {
      console.warn(
        `[MarketDataWorker] Refusing subscribe ${ticker} — at hard cap ${cap} (protected/core symbols retained)`,
      );
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
   * Drop least-scored / least-ticked non-protected watch symbols so new candidates can join
   * without exceeding Alpaca IEX subscription limits (symbol limit exceeded).
   * Always sends Alpaca unsubscribe on the open socket before the caller may subscribe.
   * Core anchors (protectedSymbols / coreStreamingSymbols) are never evicted here.
   * Unscored dynamics rank as score 0 (not +Infinity). Fresh dwell-protected symbols are skipped.
   */
  private pruneLeastActiveWatchSymbols(needed: number = 1): void {
    if (needed <= 0) return;
    const protectedSet = protectedStreamingSet();
    const ranked = Array.from(this.activeStreams)
      .filter((s) => !protectedSet.has(s))
      .filter((s) => !this.isWithinDynamicDwell(s))
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

    let removed = 0;
    for (const row of ranked) {
      if (removed >= needed) break;
      this.unsubscribe(row.symbol, { force: false });
      removed += 1;
      console.warn(
        `[MarketDataWorker] Pruned dynamic watch symbol ${row.symbol} `
        + `(score=${row.momentumScore.toFixed(3)}, ticks=${row.ticks}) `
        + `to stay within cap ${this.effectiveStreamingCap()}`,
      );
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
