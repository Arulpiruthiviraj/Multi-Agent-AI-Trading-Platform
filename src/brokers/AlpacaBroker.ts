/**
 * ==========================================================
 * Module:
 * AlpacaBroker.ts
 *
 * Purpose:
 * Core implementation and logic for the AlpacaBroker.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for AlpacaBroker
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

import { BrokerPlugin, Order, Portfolio, Position } from './BrokerAdapter.js';

export class AlpacaBroker implements BrokerPlugin {
  id = 'alpaca';
  name = 'Alpaca';
  async initialize() { console.log('[AlpacaBroker] Initialized'); }
  async validateCredentials() { return !!this.apiKey; }
  paperTrading() { this.baseUrl = 'https://paper-api.alpaca.markets'; }
  liveTrading() { this.baseUrl = 'https://api.alpaca.markets'; }
  async marketData(symbols: string[], callback: (data: any) => void) {}
  async health() { return "Healthy"; }
  
  
  private apiKey: string = '';
  private secretKey: string = '';
  private isPaper: boolean = true;
  private baseUrl: string = 'https://paper-api.alpaca.markets';

  async connect(credentials: any): Promise<boolean> {
    return this.authenticate(credentials);
  }
  async authenticate(credentials?: any): Promise<boolean> {
    if (credentials?.apiKey && credentials?.secretKey) {
      this.apiKey = credentials.apiKey;
      this.secretKey = credentials.secretKey;
    } else {
      this.apiKey = process.env.ALPACA_API_KEY || '';
      this.secretKey = process.env.ALPACA_SECRET_KEY || '';
    }
    
    if (credentials?.isLive) {
      this.isPaper = false;
      this.baseUrl = 'https://api.alpaca.markets';
    } else {
      this.isPaper = true;
      this.baseUrl = 'https://paper-api.alpaca.markets';
    }

    if (!this.apiKey || !this.secretKey) return false;
    
    try {
      const res = await this.fetchAlpaca('/v2/account');
      return !!res.id;
    } catch(e) {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    // Nothing to do for REST
  }

  private async fetchAlpaca(path: string, options: RequestInit = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'APCA-API-KEY-ID': this.apiKey,
        'APCA-API-SECRET-KEY': this.secretKey,
        'Content-Type': 'application/json',
        ...options.headers,
      }
    });
    if (!res.ok) {
       const err = await res.text();
       throw new Error(`Alpaca API Error: ${err}`);
    }
    return res.json();
  }

  async account(): Promise<any> {
    return this.fetchAlpaca('/v2/account');
  }

  async portfolio(): Promise<Portfolio> {
    const account = await this.account();
    const positions = await this.fetchAlpaca('/v2/positions');
    
    const mappedPositions = positions.map((p: any) => ({
      symbol: p.symbol,
      quantity: parseFloat(p.qty),
      entryPrice: parseFloat(p.avg_entry_price),
      currentPrice: parseFloat(p.current_price),
      marketValue: parseFloat(p.market_value),
      unrealizedPnl: parseFloat(p.unrealized_pl),
      unrealizedPnlPercent: parseFloat(p.unrealized_plpc),
    }));

    return {
      cash: parseFloat(account.cash),
      buyingPower: parseFloat(account.buying_power),
      equity: parseFloat(account.equity),
      positions: mappedPositions,
    };
  }

  async getBuyingPower(): Promise<number> {
    const account = await this.account();
    return parseFloat(account.buying_power);
  }

  async orders(): Promise<Order[]> {
    const orders = await this.fetchAlpaca('/v2/orders?status=all');
    return orders.map((o: any) => ({
      id: o.id,
      symbol: o.symbol,
      side: o.side.toUpperCase(),
      type: o.order_type.toUpperCase(),
      status: o.status.toUpperCase(),
      quantity: parseFloat(o.qty),
      filledQuantity: parseFloat(o.filled_qty),
      price: o.limit_price ? parseFloat(o.limit_price) : undefined,
      stopPrice: o.stop_price ? parseFloat(o.stop_price) : undefined,
      averageFillPrice: o.filled_avg_price ? parseFloat(o.filled_avg_price) : undefined,
      createdAt: new Date(o.created_at),
      updatedAt: new Date(o.updated_at)
    }));
  }

  async placeOrder(orderData: Partial<Order>): Promise<Order> {
    const payload: any = {
      symbol: orderData.symbol,
      qty: orderData.quantity,
      side: orderData.side?.toLowerCase(),
      type: orderData.type?.toLowerCase(),
      time_in_force: 'day'
    };
    if (payload.type === 'limit') payload.limit_price = orderData.price;
    if (payload.type === 'stop') payload.stop_price = orderData.stopPrice;
    
    const res = await this.fetchAlpaca('/v2/orders', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    
    return {
      id: res.id,
      symbol: res.symbol,
      side: res.side.toUpperCase(),
      type: res.order_type.toUpperCase(),
      status: res.status.toUpperCase(),
      quantity: parseFloat(res.qty),
      filledQuantity: parseFloat(res.filled_qty),
      createdAt: new Date(res.created_at),
      updatedAt: new Date(res.updated_at)
    };
  }

  async modifyOrder(orderId: string, updates: Partial<Order>): Promise<Order> {
    throw new Error('Not implemented');
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    await this.fetchAlpaca(`/v2/orders/${orderId}`, { method: 'DELETE' });
    return true;
  }

  async positions(): Promise<Position[]> {
    const portfolio = await this.portfolio();
    return portfolio.positions;
  }
}
