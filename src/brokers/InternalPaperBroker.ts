/**
 * ==========================================================
 * Module:
 * InternalPaperBroker.ts
 *
 * Purpose:
 * Core implementation and logic for the InternalPaperBroker.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for InternalPaperBroker
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

import { BrokerPlugin, BrokerCapabilities, Order, Portfolio, Position } from './BrokerAdapter';

export class InternalPaperBroker implements BrokerPlugin {
  async initialize() {
     console.log('[InternalPaperBroker] Initialized');
  }
  async validateCredentials() { return true; }
  paperTrading() {}
  liveTrading() {}
  getCapabilities(): BrokerCapabilities {
    return {
      canPlaceOrders: true,
      canCancelOrders: true,
      paperTrading: true,
      liveTrading: false, // in-memory simulator - there is no real broker behind it to trade live
      usEquities: true,
      canadianEquities: false,
      crypto: false,
      options: false,
      shortSelling: false, // tick() comment: "we assume long only for simplicity"
      streamingMarketData: false,
    };
  }
  async health() { return "Healthy"; }
  id = 'internal_paper';
  name = 'Argus Internal Simulator';
  isPaper = true;
  
  private cash: number = 100000;
  private _positions: Map<string, Position> = new Map();
  private _orders: Map<string, Order> = new Map();
  
  async connect(credentials: any): Promise<boolean> {
    return this.authenticate(credentials);
  }
  async authenticate(credentials?: any): Promise<boolean> {
    if (credentials?.initialCash) {
       this.cash = credentials.initialCash;
    }
    return true;
  }
  
  async disconnect(): Promise<void> {}
  
  async account(): Promise<any> {
    return { status: 'ACTIVE', id: 'argus-sim-1' };
  }
  
  async portfolio(): Promise<Portfolio> {
    const posList = Array.from(this._positions.values());
    const equity = this.cash + posList.reduce((acc, p) => acc + p.marketValue, 0);
    return {
      cash: this.cash,
      buyingPower: this.cash, // Margin not fully simulated yet
      equity: equity,
      positions: posList,
    };
  }
  
  async getBuyingPower(): Promise<number> {
    return this.cash;
  }
  
  async orders(): Promise<Order[]> {
    return Array.from(this._orders.values());
  }
  
  async placeOrder(orderData: Partial<Order>): Promise<Order> {
    const newOrder: Order = {
      id: `ord_${Date.now()}_${process.hrtime()[1]}`,
      symbol: orderData.symbol!,
      side: orderData.side!,
      type: orderData.type || 'MARKET',
      status: 'PENDING',
      quantity: orderData.quantity!,
      filledQuantity: 0,
      price: orderData.price,
      stopPrice: orderData.stopPrice,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this._orders.set(newOrder.id, newOrder);
    return newOrder;
  }
  
  async modifyOrder(orderId: string, updates: Partial<Order>): Promise<Order> {
    const order = this._orders.get(orderId);
    if (!order) throw new Error("Order not found");
    if (order.status !== 'PENDING') throw new Error("Cannot modify non-pending order");
    Object.assign(order, updates);
    order.updatedAt = new Date();
    return order;
  }
  
  async cancelOrder(orderId: string): Promise<boolean> {
    const order = this._orders.get(orderId);
    if (!order) return false;
    if (order.status !== 'PENDING') return false;
    order.status = 'CANCELED';
    order.updatedAt = new Date();
    return true;
  }
  
  async positions(): Promise<Position[]> {
    return Array.from(this._positions.values());
  }
  
  // Simulated Market tick to process orders and update PnL
  tick(currentPrices: Record<string, number>): void {
    // 1. Process Pending Orders
    for (const [id, order] of this._orders) {
      if (order.status === 'PENDING') {
        const currentPrice = currentPrices[order.symbol];
        if (!currentPrice) continue; // No price data yet
        
        let shouldFill = false;
        let fillPrice = currentPrice;
        
        // Simulating spread and slippage
        // For BUY, you pay the ask (price + spread). For SELL, you get the bid (price - spread)
        const spread = currentPrice * 0.0005; // 0.05% spread
        const slippage = 0; // Removed fake slippage
        
        if (order.side === 'BUY') fillPrice += spread + slippage;
        if (order.side === 'SELL') fillPrice -= (spread + slippage);

        if (order.type === 'MARKET') {
          shouldFill = true;
        } else if (order.type === 'LIMIT') {
          if (order.side === 'BUY' && fillPrice <= order.price!) shouldFill = true;
          if (order.side === 'SELL' && fillPrice >= order.price!) shouldFill = true;
        } else if (order.type === 'STOP') {
          if (order.side === 'SELL' && fillPrice <= order.stopPrice!) shouldFill = true;
          if (order.side === 'BUY' && fillPrice >= order.stopPrice!) shouldFill = true;
        }
        
        if (shouldFill) {
          const cost = fillPrice * order.quantity;
          if (order.side === 'BUY' && this.cash < cost) {
            order.status = 'REJECTED'; // Insufficient funds
            order.updatedAt = new Date();
            continue;
          }
          
          // Execute the fill
          order.status = 'FILLED';
          order.averageFillPrice = fillPrice;
          order.filledQuantity = order.quantity;
          order.updatedAt = new Date();
          
          // Update Cash and Position
          if (order.side === 'BUY') {
            this.cash -= cost;
            const pos = this._positions.get(order.symbol);
            if (pos) {
               const newQty = pos.quantity + order.quantity;
               const newTotalCost = pos.entryPrice * pos.quantity + cost;
               pos.entryPrice = newTotalCost / newQty;
               pos.quantity = newQty;
            } else {
               this._positions.set(order.symbol, {
                 symbol: order.symbol,
                 quantity: order.quantity,
                 entryPrice: fillPrice,
                 currentPrice: fillPrice,
                 marketValue: cost,
                 unrealizedPnl: 0,
                 unrealizedPnlPercent: 0
               });
            }
          } else if (order.side === 'SELL') {
             this.cash += cost;
             const pos = this._positions.get(order.symbol);
             if (pos) {
                if (pos.quantity <= order.quantity) {
                   this._positions.delete(order.symbol); // closed out
                } else {
                   pos.quantity -= order.quantity;
                }
             }
             // For short selling, we would handle negative quantity, but we assume long only for simplicity unless requested
          }
        }
      }
    }
    
    // 2. Update Unrealized PnL for open positions
    for (const [symbol, pos] of this._positions) {
      const currentPrice = currentPrices[symbol];
      if (currentPrice) {
        pos.currentPrice = currentPrice;
        pos.marketValue = currentPrice * pos.quantity;
        const totalCost = pos.entryPrice * pos.quantity;
        pos.unrealizedPnl = pos.marketValue - totalCost;
        pos.unrealizedPnlPercent = pos.unrealizedPnl / totalCost;
      }
    }
  }
}
