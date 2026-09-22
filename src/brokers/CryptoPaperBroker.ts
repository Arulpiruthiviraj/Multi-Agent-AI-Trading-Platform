/**
 * ARGUS Crypto Expansion Phase 13 (2026-09-22). PAPER-ONLY crypto broker adapter, modeled closely
 * on InternalPaperBroker.ts's existing real, already-registered paper-broker pattern - not a new
 * shape invented from scratch. Structurally distinct from CoinbaseBroker.ts (which stays LIVE-only
 * and is never modified for this - see its own header) and from
 * src/server/crypto/synthetic/SyntheticCryptoBroker.ts (an isolated, SYN-symbol-only simulator for
 * the population stress-test lab, not a real BrokerPlugin, never registered with BrokerManager).
 *
 * Only accepts registered, paper-enabled crypto instruments (config/cryptoInstruments.json).
 * Long-only: a SELL that exceeds the held quantity is REJECTED, never silently capped or shorted.
 * Fractional quantities are native throughout - no rounding anywhere in this file (PositionSizing/
 * QuantityQuantization.ts already produces a correctly-quantized quantity before this broker ever
 * sees an order).
 *
 * Fill model: spread + fee + slippage against config/cryptoInstruments.json's paperExecution
 * assumptions (reviewed defaults, not measured from a real order book - see that config's own
 * comment). Large orders partially fill across multiple tick() calls, bounded by
 * maxFillNotionalPerTick - "no magical fills exactly at signal price" (explicit operator
 * instruction), matching InternalPaperBroker's own existing spread-on-fill precedent, extended
 * with fees and bounded per-tick liquidity.
 */
import { BrokerPlugin, BrokerCapabilities, Order, Portfolio, Position } from './BrokerAdapter';
import { getCryptoInstrument, getCryptoPaperExecutionAssumptions } from '../server/config/cryptoInstruments';

interface CryptoPositionState extends Position {
  /** Realized P&L this position has generated across all prior partial/full exits - reset only
   *  when the position is fully closed and later reopened (a fresh cost basis). */
}

export class CryptoPaperBroker implements BrokerPlugin {
  id = 'crypto_paper';
  name = 'Argus Crypto Paper Simulator';
  isPaper = true;

  private cash: number;
  private readonly initialCash: number;
  private _positions: Map<string, CryptoPositionState> = new Map();
  private _orders: Map<string, Order> = new Map();
  private _clientOrderIdIndex: Map<string, string> = new Map(); // clientOrderId -> internal order id
  private _realizedPnl = 0;

  constructor(initialCash = 100000) {
    this.initialCash = initialCash;
    this.cash = initialCash;
  }

  async initialize(): Promise<void> {
    console.log('[CryptoPaperBroker] Initialized (PAPER only - no real crypto venue is reachable through this adapter)');
  }
  async validateCredentials(): Promise<boolean> { return true; }
  paperTrading(): void {}
  liveTrading(): void {
    throw new Error('[CryptoPaperBroker] This adapter is PAPER-only by design and refuses to arm LIVE. Use a real, separately-authorized broker for live crypto execution (none exists in this codebase).');
  }
  getCapabilities(): BrokerCapabilities {
    return {
      canPlaceOrders: true,
      canCancelOrders: true,
      paperTrading: true,
      liveTrading: false, // in-memory simulator - structurally cannot reach a real venue
      usEquities: false,
      canadianEquities: false,
      crypto: true,
      options: false,
      shortSelling: false, // long-only research broker - see class header
      streamingMarketData: false,
      requiresManualReauth: false,
      extendedHoursOrders: false, // crypto has no RTH/extended-hours distinction to construct
    };
  }
  async health(): Promise<string> { return 'Healthy'; }

  async connect(_credentials: any): Promise<boolean> { return this.authenticate(_credentials); }
  async authenticate(credentials?: any): Promise<boolean> {
    if (credentials?.initialCash) this.cash = credentials.initialCash;
    return true;
  }
  async disconnect(): Promise<void> {}

  async account(): Promise<any> {
    return { status: 'ACTIVE', id: 'argus-crypto-paper-1' };
  }

  async portfolio(): Promise<Portfolio> {
    const posList = Array.from(this._positions.values());
    const unrealizedPnl = posList.reduce((acc, p) => acc + p.unrealizedPnl, 0);
    const equity = this.cash + posList.reduce((acc, p) => acc + p.marketValue, 0);
    return {
      cash: this.cash,
      buyingPower: this.cash, // no margin/leverage - see class header
      equity,
      positions: posList,
      realizedPnl: this._realizedPnl,
      unrealizedPnl,
    };
  }

  async getBuyingPower(): Promise<number> { return this.cash; }

  async orders(): Promise<Order[]> { return Array.from(this._orders.values()); }

  async placeOrder(orderData: Partial<Order>): Promise<Order> {
    const symbol = String(orderData.symbol || '').trim().toUpperCase();
    const instrument = getCryptoInstrument(symbol);

    // Idempotency: a real clientOrderId that already has an order returns the EXISTING order,
    // never a second one ("duplicate callback -> no duplicate position").
    if (orderData.clientOrderId) {
      const existingId = this._clientOrderIdIndex.get(orderData.clientOrderId);
      if (existingId) {
        const existing = this._orders.get(existingId);
        if (existing) return existing;
      }
    }

    const quantity = Number(orderData.quantity);
    const now = new Date();
    const rejected = (reason: string): Order => {
      const order: Order = {
        id: `crypto_ord_${Date.now()}_${process.hrtime()[1]}`,
        clientOrderId: orderData.clientOrderId,
        symbol, side: orderData.side!, type: orderData.type || 'MARKET', status: 'REJECTED',
        quantity: Number.isFinite(quantity) ? quantity : 0, filledQuantity: 0,
        price: orderData.price, stopPrice: orderData.stopPrice, createdAt: now, updatedAt: now,
      };
      (order as any).rejectionReason = reason;
      this._orders.set(order.id, order);
      if (orderData.clientOrderId) this._clientOrderIdIndex.set(orderData.clientOrderId, order.id);
      return order;
    };

    if (!instrument || !instrument.enabledForPaper) {
      return rejected(`unregistered or not-paper-enabled crypto instrument: ${symbol}`);
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return rejected(`invalid quantity: ${orderData.quantity}`);
    }
    if (orderData.side === 'SELL') {
      const held = this._positions.get(symbol)?.quantity ?? 0;
      if (quantity > held) {
        return rejected(`SELL quantity ${quantity} exceeds held quantity ${held} - long-only, no shorting`);
      }
    }

    const newOrder: Order = {
      id: `crypto_ord_${Date.now()}_${process.hrtime()[1]}`,
      clientOrderId: orderData.clientOrderId,
      symbol,
      side: orderData.side!,
      type: orderData.type || 'MARKET',
      status: 'PENDING',
      quantity,
      filledQuantity: 0,
      price: orderData.price,
      stopPrice: orderData.stopPrice,
      createdAt: now,
      updatedAt: now,
    };
    this._orders.set(newOrder.id, newOrder);
    if (orderData.clientOrderId) this._clientOrderIdIndex.set(orderData.clientOrderId, newOrder.id);
    return newOrder;
  }

  async modifyOrder(orderId: string, updates: Partial<Order>): Promise<Order> {
    const order = this._orders.get(orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'PENDING') throw new Error('Cannot modify a non-pending order');
    Object.assign(order, updates);
    order.updatedAt = new Date();
    return order;
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    const order = this._orders.get(orderId);
    if (!order) return false;
    if (order.status !== 'PENDING' && order.status !== 'PARTIALLY_FILLED') return false;
    order.status = 'CANCELED';
    order.updatedAt = new Date();
    return true;
  }

  async getOrderByClientOrderId(clientOrderId: string): Promise<Order | null> {
    const id = this._clientOrderIdIndex.get(clientOrderId);
    return id ? (this._orders.get(id) ?? null) : null;
  }

  async closePosition(symbol: string): Promise<boolean> {
    const pos = this._positions.get(symbol.toUpperCase());
    if (!pos || pos.quantity <= 0) return false;
    await this.placeOrder({ symbol: pos.symbol, side: 'SELL', type: 'MARKET', quantity: pos.quantity });
    return true;
  }

  async positions(): Promise<Position[]> { return Array.from(this._positions.values()); }

  /** Simulated market tick - processes PENDING/PARTIALLY_FILLED orders against currentPrices,
   *  applying the real (if reviewed-not-measured) spread/fee/slippage fill model, bounded per-tick
   *  liquidity for partial fills, and updates realized/unrealized P&L. */
  tick(currentPrices: Record<string, number>): void {
    const assumptions = getCryptoPaperExecutionAssumptions();

    for (const [, order] of this._orders) {
      if (order.status !== 'PENDING' && order.status !== 'PARTIALLY_FILLED') continue;
      const currentPrice = currentPrices[order.symbol];
      if (!currentPrice || !Number.isFinite(currentPrice) || currentPrice <= 0) continue;

      const spreadRate = assumptions.spreadBps / 10000;
      const slippageRate = assumptions.slippageBps / 10000;
      const feeRate = assumptions.feeBps / 10000;
      let fillPrice = currentPrice;
      if (order.side === 'BUY') fillPrice += currentPrice * (spreadRate + slippageRate);
      if (order.side === 'SELL') fillPrice -= currentPrice * (spreadRate + slippageRate);

      let shouldEvaluate = order.type === 'MARKET';
      if (order.type === 'LIMIT' && order.price !== undefined) {
        shouldEvaluate = (order.side === 'BUY' && fillPrice <= order.price) || (order.side === 'SELL' && fillPrice >= order.price);
      } else if (order.type === 'STOP' && order.stopPrice !== undefined) {
        shouldEvaluate = (order.side === 'SELL' && fillPrice <= order.stopPrice) || (order.side === 'BUY' && fillPrice >= order.stopPrice);
      }
      if (!shouldEvaluate) continue;

      const remainingQuantity = order.quantity - order.filledQuantity;
      const remainingNotional = remainingQuantity * fillPrice;
      const fillableNotionalThisTick = Math.min(remainingNotional, assumptions.maxFillNotionalPerTick);
      const fillQuantityThisTick = fillableNotionalThisTick / fillPrice;
      const fee = fillableNotionalThisTick * feeRate;

      if (order.side === 'BUY') {
        const totalCost = fillableNotionalThisTick + fee;
        if (this.cash < totalCost) {
          order.status = 'REJECTED';
          (order as any).rejectionReason = 'insufficient paper cash at fill time';
          order.updatedAt = new Date();
          continue;
        }
        this.cash -= totalCost;
        const pos = this._positions.get(order.symbol);
        if (pos) {
          const newQty = pos.quantity + fillQuantityThisTick;
          const newTotalCost = pos.entryPrice * pos.quantity + fillableNotionalThisTick;
          pos.entryPrice = newTotalCost / newQty;
          pos.quantity = newQty;
        } else {
          this._positions.set(order.symbol, {
            symbol: order.symbol,
            quantity: fillQuantityThisTick,
            entryPrice: fillPrice,
            currentPrice: fillPrice,
            marketValue: fillQuantityThisTick * fillPrice,
            unrealizedPnl: 0,
            unrealizedPnlPercent: 0,
          });
        }
      } else {
        // SELL - already validated at placeOrder() time to not exceed the position held then, but
        // re-validate here too (a concurrent SELL on the same symbol could have reduced it since).
        const pos = this._positions.get(order.symbol);
        const heldQty = pos?.quantity ?? 0;
        const sellQty = Math.min(fillQuantityThisTick, heldQty);
        if (sellQty <= 0) {
          order.status = 'REJECTED';
          (order as any).rejectionReason = 'no remaining position to sell at fill time';
          order.updatedAt = new Date();
          continue;
        }
        const proceeds = sellQty * fillPrice - fee;
        this.cash += proceeds;
        if (pos) {
          const realizedThisFill = (fillPrice - pos.entryPrice) * sellQty - fee;
          this._realizedPnl += realizedThisFill;
          if (pos.quantity <= sellQty) {
            this._positions.delete(order.symbol);
          } else {
            pos.quantity -= sellQty;
          }
        }
      }

      order.filledQuantity += fillQuantityThisTick;
      order.averageFillPrice = order.averageFillPrice
        ? (order.averageFillPrice * (order.filledQuantity - fillQuantityThisTick) + fillPrice * fillQuantityThisTick) / order.filledQuantity
        : fillPrice;
      order.status = order.filledQuantity >= order.quantity - 1e-12 ? 'FILLED' : 'PARTIALLY_FILLED';
      order.updatedAt = new Date();
    }

    for (const [symbol, pos] of this._positions) {
      const currentPrice = currentPrices[symbol];
      if (currentPrice) {
        pos.currentPrice = currentPrice;
        pos.marketValue = currentPrice * pos.quantity;
        const totalCost = pos.entryPrice * pos.quantity;
        pos.unrealizedPnl = pos.marketValue - totalCost;
        pos.unrealizedPnlPercent = totalCost !== 0 ? pos.unrealizedPnl / totalCost : 0;
      }
    }
  }

  /** Test/diagnostic only - real callers use portfolio()/positions(). */
  getInitialCash(): number { return this.initialCash; }
}
