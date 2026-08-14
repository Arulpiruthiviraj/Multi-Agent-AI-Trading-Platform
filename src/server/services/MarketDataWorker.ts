/**
 * ==========================================================
 * Module:
 * MarketDataWorker.ts
 *
 * Purpose:
 * Core implementation and logic for the MarketDataWorker.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for MarketDataWorker
 * - Interface with backend APIs and EventBus
 * - Render UI components (if React)
 *
 * Inputs:
 * - Module dependencies and injected props
 *
 * Outputs:
 * - Formatted data or React Elements
 *
 * Emits:
 * - Relevant system events
 *
 * Dependencies:
 * - Standard Argus architecture layers
 *
 * Called By:
 * - Argus Routing / Parent Components
 *
 * Never:
 * - Mutate global state directly without EventBus
 * - Call AI providers directly (Must use AIRouter)
 *
 * ==========================================================
 */

import { eventBus } from '../core/EventBus';
import WebSocket from 'ws';

export class MarketDataWorker {
  private activeStreams: Set<string> = new Set();
  private intervalId: NodeJS.Timeout | null = null;
  private ws: WebSocket | null = null;
  private latestPrices: Map<string, number> = new Map();
  private latestPriceTimestamps: Map<string, number> = new Map();
  // Hardening pass, Phase 4: the last real (exchange timestamp, price) actually processed per
  // symbol - a WS reconnect/redelivery can hand back the identical tick Alpaca already sent, and
  // re-processing it re-triggers every downstream agent evaluation for a tick that isn't actually
  // new. Keyed on the tick's own real exchange timestamp (msg.t), not Date.now() - two distinct
  // real ticks essentially never share both the same exchange timestamp AND price, so this never
  // discards a legitimate new tick, only an exact redelivery of one already processed.
  private lastTick: Map<string, { timestampMs: number; price: number }> = new Map();
  // Set the moment the socket actually drops; cleared once a reconnect successfully
  // re-authenticates. Used to make a real data gap observable rather than fabricating ticks for
  // it - there is no durable tick-level store to backfill from (unlike Phase 9's event_traces).
  private disconnectedAt: number | null = null;

  getLatestPrice(symbol: string): number | null {
    return this.latestPrices.get(symbol) || null;
  }

  // Real currently-subscribed symbol list, not a fabricated watchlist - used by
  // MarketDataCrossChecker to know which symbols actually have a live Alpaca feed to compare
  // Questrade's quote against.
  getActiveSymbols(): string[] {
    return Array.from(this.activeStreams);
  }

  // Milliseconds since the last real MARKET_DATA tick for this symbol, or null if none has
  // ever arrived (e.g. no Alpaca keys configured) - callers must not treat null as "fresh".
  getLatestPriceAgeMs(symbol: string): number | null {
    const t = this.latestPriceTimestamps.get(symbol);
    return typeof t === 'number' ? Date.now() - t : null;
  }

  // Real WebSocket readyState check, not a fabricated "connected" flag - used by Mission
  // Control's MARKET DATA status indicator.
  isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  // True only for an exact redelivery of a tick already processed (same symbol, same real
  // exchange timestamp, same price) - not merely "close in time," which could discard a
  // legitimate fast-moving real tick.
  private isDuplicateTick(symbol: string, timestampMs: number, price: number): boolean {
    const last = this.lastTick.get(symbol);
    return !!last && last.timestampMs === timestampMs && last.price === price;
  }

  start() {
    if (this.intervalId || this.ws) return;
    
    if (process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY) {
      console.log("[MarketDataWorker] Connecting to live Alpaca WebSocket...");
      this.connectAlpaca();
    } else {
      console.log("[MarketDataWorker] No Alpaca keys provided. MarketDataWorker will idle in disconnected state without fabricating data.");
      eventBus.emit("MARKET_DATA_DISCONNECTED", { reason: "Missing API keys" });
    }
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    console.log("[MarketDataWorker] Disconnected.");
  }

  subscribe(symbol: string) {
    this.activeStreams.add(symbol);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: "subscribe", quotes: [symbol] }));
    }
    console.log(`[MarketDataWorker] Subscribed to ${symbol}`);
  }

  unsubscribe(symbol: string) {
    this.activeStreams.delete(symbol);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: "unsubscribe", quotes: [symbol] }));
    }
  }

  private connectAlpaca() {
    this.ws = new WebSocket("wss://stream.data.alpaca.markets/v2/iex");
    
    this.ws.on("open", () => {
      this.ws?.send(JSON.stringify({
        action: "auth",
        key: process.env.ALPACA_API_KEY,
        secret: process.env.ALPACA_SECRET_KEY
      }));
    });

    this.ws.on("message", (data) => {
      const messages = JSON.parse(data.toString());
      for (const msg of messages) {
        if (msg.T === "success" && msg.msg === "authenticated") {
          const symbols = Array.from(this.activeStreams);
          if (symbols.length > 0) {
            this.ws?.send(JSON.stringify({ action: "subscribe", quotes: symbols }));
          }
          // Hardening pass, Phase 4: the feed is genuinely live again as of right now (not just
          // "socket open," which fires before auth completes) - this is the real end of any gap.
          // There's no durable tick-level store to backfill missed ticks from (unlike Phase 9's
          // event_traces for WS events), so this makes the gap honestly observable instead of
          // silently pretending nothing was missed.
          if (this.disconnectedAt !== null) {
            const gapMs = Date.now() - this.disconnectedAt;
            console.warn(`[MarketDataWorker] Reconnected after a ${Math.round(gapMs / 1000)}s data gap - any ticks during that window were not received (no tick-level backfill source exists).`);
            eventBus.emit('MARKET_DATA_GAP_DETECTED', { gapMs, disconnectedAt: this.disconnectedAt, reconnectedAt: Date.now() });
            this.disconnectedAt = null;
          }
        } else if (msg.T === "q") {
          // Quote message
          const timestampMs = new Date(msg.t).getTime();
          if (this.isDuplicateTick(msg.S, timestampMs, msg.bp)) continue; // exact redelivery, not a new tick
          this.lastTick.set(msg.S, { timestampMs, price: msg.bp });
          this.latestPrices.set(msg.S, msg.bp);
          this.latestPriceTimestamps.set(msg.S, Date.now());
          eventBus.emitMarketData(msg.S, msg.bp, msg.bs, new Date(msg.t).toISOString());
        } else if (msg.T === "t") {
          // Trade message
          const timestampMs = new Date(msg.t).getTime();
          if (this.isDuplicateTick(msg.S, timestampMs, msg.p)) continue; // exact redelivery, not a new tick
          this.lastTick.set(msg.S, { timestampMs, price: msg.p });
          this.latestPrices.set(msg.S, msg.p);
          this.latestPriceTimestamps.set(msg.S, Date.now());
          eventBus.emitMarketData(msg.S, msg.p, msg.s, new Date(msg.t).toISOString());
        }
      }
    });

    this.ws.on("error", (err) => {
      console.error("[MarketDataWorker] WebSocket error:", err);
    });

    this.ws.on("close", () => {
      // Real start of the gap - captured here, not when the reconnect later succeeds, so the
      // reported gap duration reflects how long the feed was actually down.
      if (this.disconnectedAt === null) this.disconnectedAt = Date.now();
      console.log("[MarketDataWorker] WebSocket closed. Reconnecting...");
      setTimeout(() => this.connectAlpaca(), 5000);
    });
  }

  }
export const marketDataWorker = new MarketDataWorker();
