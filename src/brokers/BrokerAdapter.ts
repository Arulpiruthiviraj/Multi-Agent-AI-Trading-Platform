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

// Describes what an adapter can ACTUALLY do, as implemented right now - not what the broker's
// own API is theoretically capable of. canPlaceOrders MUST be false for any adapter whose
// placeOrder() is unimplemented; nothing here may claim support that the adapter code doesn't
// back up, since this drives what the UI is allowed to tell the user is available.
export interface BrokerCapabilities {
  canPlaceOrders: boolean;
  canCancelOrders: boolean;
  paperTrading: boolean;
  liveTrading: boolean;
  usEquities: boolean;
  canadianEquities: boolean;
  crypto: boolean;
  options: boolean;
  shortSelling: boolean;
  streamingMarketData: boolean; // via this adapter's own marketData() - not MarketDataWorker
}

export interface BrokerPlugin {
  id: string;
  name: string;

  initialize(): Promise<void>;
  authenticate(credentials: any): Promise<boolean>;
  validateCredentials(): Promise<boolean>;
  paperTrading(): void;
  liveTrading(): void;
  getCapabilities(): BrokerCapabilities;
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

export function brokerSupports(broker: BrokerPlugin, capability: keyof BrokerCapabilities): boolean {
  return !!broker.getCapabilities()[capability];
}