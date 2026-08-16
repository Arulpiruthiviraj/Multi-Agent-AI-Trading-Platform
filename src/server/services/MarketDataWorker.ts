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
 * ==========================================================
 */

import WebSocket from 'ws';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { loadRepoConfigJson } from '../config/loadRepoConfigJson';
import { runtimeIntervals } from '../config/runtimeIntervals';

const DEFAULT_STREAM_URL = 'wss://stream.data.alpaca.markets/v2/iex';
const RECONNECT_MS = runtimeIntervals.marketDataReconnectMs;

function defaultSubscribeSymbols(): string[] {
  try {
    const cfg = loadRepoConfigJson<{ markets?: { US?: { benchmarks?: string[] } } }>('markets.json');
    const benches = cfg.markets?.US?.benchmarks;
    return Array.isArray(benches) ? benches.filter(s => typeof s === 'string' && s.length > 0) : [];
  } catch {
    return [];
  }
}

export class MarketDataWorker {
  private activeStreams: Set<string> = new Set();
  private intervalId: NodeJS.Timeout | null = null;
  private ws: WebSocket | null = null;
  private latestPrices: Map<string, number> = new Map();
  private latestPriceTimestamps: Map<string, number> = new Map();
  private lastTick: Map<string, { timestampMs: number; price: number }> = new Map();
  private disconnectedAt: number | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;
  private authenticated = false;

  getLatestPrice(symbol: string): number | null {
    return this.latestPrices.get(symbol) || null;
  }

  getActiveSymbols(): string[] {
    return Array.from(this.activeStreams);
  }

  getLatestPriceAgeMs(symbol: string): number | null {
    const t = this.latestPriceTimestamps.get(symbol);
    return typeof t === 'number' ? Date.now() - t : null;
  }

  isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  getFeedStatus(): {
    connected: boolean;
    readyState: number | null;
    authenticated: boolean;
    lastError: string | null;
    symbols: string[];
  } {
    return {
      connected: this.isConnected(),
      readyState: this.ws ? this.ws.readyState : null,
      authenticated: this.authenticated,
      lastError: this.lastError,
      symbols: this.getActiveSymbols(),
    };
  }

  private isDuplicateTick(symbol: string, timestampMs: number, price: number): boolean {
    const last = this.lastTick.get(symbol);
    return !!last && last.timestampMs === timestampMs && last.price === price;
  }

  start() {
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
    this.tearDownSocket();
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

  subscribe(symbol: string) {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) return;
    this.activeStreams.add(sym);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: "subscribe", quotes: [sym], trades: [sym] }));
    }
    console.log(`[MarketDataWorker] Subscribed to ${sym}`);
  }

  unsubscribe(symbol: string) {
    this.activeStreams.delete(symbol);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: "unsubscribe", quotes: [symbol], trades: [symbol] }));
    }
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
    if (this.activeStreams.size > 0) return;
    for (const s of defaultSubscribeSymbols()) this.activeStreams.add(s);
  }

  private sendSubscribe(socket: WebSocket) {
    this.ensureDefaultSubscriptions();
    const symbols = Array.from(this.activeStreams);
    if (symbols.length === 0) {
      console.warn('[MarketDataWorker] Authenticated but no symbols to subscribe (config/markets.json US.benchmarks empty).');
      return;
    }
    socket.send(JSON.stringify({ action: 'subscribe', quotes: symbols, trades: symbols }));
  }

  private connectAlpaca() {
    this.clearReconnectTimer();
    const url = process.env.ALPACA_DATA_STREAM_URL || DEFAULT_STREAM_URL;
    console.log(`[MarketDataWorker] Connecting to Alpaca market-data WebSocket (${url})...`);
    const socket = new WebSocket(url);
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
          eventBus.emit(EVENTS.MARKET_DATA_DISCONNECTED, { reason: this.lastError });
        } else if (msg.T === "q") {
          const timestampMs = new Date(msg.t).getTime();
          if (this.isDuplicateTick(msg.S, timestampMs, msg.bp)) continue;
          this.lastTick.set(msg.S, { timestampMs, price: msg.bp });
          this.latestPrices.set(msg.S, msg.bp);
          this.latestPriceTimestamps.set(msg.S, Date.now());
          eventBus.emitMarketData(msg.S, msg.bp, msg.bs, new Date(msg.t).toISOString());
        } else if (msg.T === "t") {
          const timestampMs = new Date(msg.t).getTime();
          if (this.isDuplicateTick(msg.S, timestampMs, msg.p)) continue;
          this.lastTick.set(msg.S, { timestampMs, price: msg.p });
          this.latestPrices.set(msg.S, msg.p);
          this.latestPriceTimestamps.set(msg.S, Date.now());
          eventBus.emitMarketData(msg.S, msg.p, msg.s, new Date(msg.t).toISOString());
        }
      }
    });

    socket.on("error", (err) => {
      if (this.ws !== socket) return;
      this.lastError = err?.message || String(err);
      console.error("[MarketDataWorker] WebSocket error:", err);
    });

    socket.on("close", () => {
      if (this.ws !== socket) return;
      this.authenticated = false;
      this.ws = null;
      if (this.disconnectedAt === null) this.disconnectedAt = Date.now();
      console.log("[MarketDataWorker] WebSocket closed. Reconnecting...");
      eventBus.emit(EVENTS.MARKET_DATA_DISCONNECTED, { reason: this.lastError || "socket closed" });
      this.clearReconnectTimer();
      this.reconnectTimer = setTimeout(() => this.connectAlpaca(), RECONNECT_MS);
    });
  }

}
export const marketDataWorker = new MarketDataWorker();
