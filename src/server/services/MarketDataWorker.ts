import { eventBus } from '../core/EventBus';
import WebSocket from 'ws';

export class MarketDataWorker {
  private activeStreams: Set<string> = new Set();
  private intervalId: NodeJS.Timeout | null = null;
  private ws: WebSocket | null = null;
  private latestPrices: Map<string, number> = new Map();

  getLatestPrice(symbol: string): number | null {
    return this.latestPrices.get(symbol) || null;
  }

  start() {
    if (this.intervalId || this.ws) return;
    
    if (process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY) {
      console.log("[MarketDataWorker] Connecting to live Alpaca WebSocket...");
      this.connectAlpaca();
    } else {
      console.log("[MarketDataWorker] Connecting to mock data streams (No Alpaca keys)...");
      this.intervalId = setInterval(() => this.pollMockData(), 3000);
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
          eventBus.emitMarketData(msg.S, msg.bp, msg.bs, new Date(msg.t).toISOString());
        } else if (msg.T === "t") {
          // Trade message
          this.latestPrices.set(msg.S, msg.p);
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

  private pollMockData() {
    const symbols = Array.from(this.activeStreams);
    if (symbols.length === 0) {
      ['NVDA', 'AAPL', 'TSLA'].forEach(s => this.activeStreams.add(s));
      return;
    }
    symbols.forEach(symbol => {
      const mockPrice = 150 + Math.random() * 20;
      const mockVolume = Math.floor(Math.random() * 1000);
      this.latestPrices.set(symbol, mockPrice);
      eventBus.emitMarketData(symbol, mockPrice, mockVolume, new Date().toISOString());
    });
  }
}
export const marketDataWorker = new MarketDataWorker();
