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

  getLatestPrice(symbol: string): number | null {
    return this.latestPrices.get(symbol) || null;
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
        } else if (msg.T === "q") {
          // Quote message
          this.latestPrices.set(msg.S, msg.bp);
          this.latestPriceTimestamps.set(msg.S, Date.now());
          eventBus.emitMarketData(msg.S, msg.bp, msg.bs, new Date(msg.t).toISOString());
        } else if (msg.T === "t") {
          // Trade message
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
      console.log("[MarketDataWorker] WebSocket closed. Reconnecting...");
      setTimeout(() => this.connectAlpaca(), 5000);
    });
  }

  }
export const marketDataWorker = new MarketDataWorker();
