/**
 * ==========================================================
 * Module:
 * MarketDataAdapter.ts
 *
 * Purpose:
 * Core implementation and logic for the MarketDataAdapter.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for MarketDataAdapter
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

export interface Candle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  timestamp: string;
}

export interface MarketDataAdapter {
  id: string;
  name: string;
  
  connect(credentials: any): Promise<boolean>;
  disconnect(): Promise<void>;
  
  getQuote(symbol: string): Promise<Quote>;
  getHistoricalCandles(symbol: string, timeframe: string, limit: number): Promise<Candle[]>;
  streamQuotes(symbols: string[], callback: (quote: Quote) => void): Promise<void>;
  
  // Future methods for Level 2 data, options, etc.
  getOptionChain?(symbol: string): Promise<any>;
}
