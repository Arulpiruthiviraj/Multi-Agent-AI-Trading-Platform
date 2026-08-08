/**
 * ==========================================================
 * Module: BrokerPlugin.ts
 * Purpose: Defines the contract for all broker plugins in Argus.
 * ==========================================================
 */

export interface OrderRequest {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  type: 'MARKET' | 'LIMIT' | 'STOP';
  limitPrice?: number;
  stopPrice?: number;
}

export interface OrderResult {
  orderId: string;
  status: 'PENDING' | 'FILLED' | 'REJECTED' | 'CANCELED';
  filledPrice?: number;
  filledQuantity?: number;
  timestamp: string;
  error?: string;
}

export interface Position {
  symbol: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnl: number;
}

export interface BrokerPlugin {
  name: string;
  connect(credentials: any): Promise<boolean>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  
  // Market Data
  getQuote(symbol: string): Promise<{ price: number; timestamp: string } | null>;
  
  // Trading
  submitOrder(order: OrderRequest): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<boolean>;
  
  // Portfolio
  getPositions(): Promise<Position[]>;
  getCashBalance(): Promise<number>;
}
