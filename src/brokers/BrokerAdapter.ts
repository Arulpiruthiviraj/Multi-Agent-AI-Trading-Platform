/**
 * ==========================================================
 * Module:
 * BrokerAdapter.ts
 *
 * Purpose:
 * Core implementation and logic for the BrokerAdapter.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for BrokerAdapter
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

export interface Order {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT' | 'TRAILING_STOP' | 'BRACKET' | 'OCO' | 'ICEBERG' | 'TWAP' | 'VWAP';
  status: 'PENDING' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELED' | 'REJECTED';
  quantity: number;
  filledQuantity: number;
  price?: number;
  stopPrice?: number;
  averageFillPrice?: number;
  createdAt: Date;
  updatedAt: Date;
  // Specific fields for advanced orders
  trailPercent?: number;
  trailAmount?: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
}

export interface Position {
  symbol: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
}

export interface Portfolio {
  cash: number;
  buyingPower: number;
  equity: number;
  positions: Position[];
  dailyPnl?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
}

export interface AccountActivity {
  id: string;
  type: 'DEPOSIT' | 'WITHDRAWAL' | 'DIVIDEND' | 'FEE' | 'TRADE';
  amount: number;
  timestamp: string;
  description: string;
}

export interface BrokerPlugin {
  id: string;
  name: string;

  initialize(): Promise<void>;
  authenticate(credentials: any): Promise<boolean>;
  validateCredentials(): Promise<boolean>;
  paperTrading(): void;
  liveTrading(): void;
  marketData(symbols: string[], callback: (data: any) => void): Promise<void>;
  portfolio(): Promise<Portfolio>;
  orders(): Promise<Order[]>;
  positions(): Promise<Position[]>;
  account(): Promise<any>;
  disconnect(): Promise<void>;
  health(): Promise<string>; // e.g. "Healthy", "Offline", "Degraded"
  
  // internal methods for specific orders
  placeOrder(order: Partial<Order>): Promise<Order>;
  cancelOrder(orderId: string): Promise<boolean>;
  
  tick?(currentPrices: Record<string, number>): void;
}