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
// @ts-nocheck

import { BrokerPlugin, BrokerCapabilities, Order, Portfolio, Position } from './BrokerAdapter';
import { getCryptoInstrument, getCryptoPaperExecutionAssumptions } from '../server/config/cryptoInstruments';
import { db } from '../server/db';
import { cryptoPaperBrokerState, cryptoPaperOrders, cryptoPaperPositions } from '../server/db/schema';
import { eq } from 'drizzle-orm';

const STATE_ROW_ID = 'singleton';

function orderToRow(order: Order) {
  return {
    id: order.id,
    clientOrderId: order.clientOrderId ?? null,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    status: order.status,
    quantity: order.quantity,
    filledQuantity: order.filledQuantity,
    price: order.price ?? null,
    stopPrice: order.stopPrice ?? null,
    averageFillPrice: order.averageFillPrice ?? null,
    rejectionReason: (order as any).rejectionReason ?? null,
    createdAt: (order.createdAt instanceof Date ? order.createdAt : new Date(order.createdAt as any)).toISOString(),
    updatedAt: (order.updatedAt instanceof Date ? order.updatedAt : new Date(order.updatedAt as any)).toISOString(),
  };
}

interface CryptoPositionState extends Position {
  entryFees: number;
  /** Realized P&L this position has generated across all prior partial/full exits - reset only
   *  when the position is fully closed and later reopened (a fresh cost basis). */
}

export class CryptoPaperBroker implements BrokerPlugin {
  id = 'crypto_paper';
  name = 'Argus Crypto Paper Simulator';
  isPaper = true;

  private cash: number;
  // Not readonly: initialize() overwrites this from durable state on a restart that finds an
  // existing crypto_paper_broker_state row - the constructor's value is only the fresh-boot default.
  private initialCash: number;
  private _positions: Map<string, CryptoPositionState> = new Map();
  private _orders: Map<string, Order> = new Map();
  private _clientOrderIdIndex: Map<string, string> = new Map(); // clientOrderId -> internal order id
  private _realizedPnl = 0;
  private triggeredStops = new Set<string>();

  private validateOrder(order: Partial<Order>, excludeOrderId?: string): string | null {
    if (order.side !== 'BUY' && order.side !== 'SELL') return 'invalid order side';
    if (!['MARKET', 'LIMIT', 'STOP'].includes(order.type || 'MARKET')) return 'unsupported order type';
    if (!Number.isFinite(order.quantity) || !(order.quantity! > 0)) return 'invalid quantity';
    if (order.type === 'LIMIT' && (!Number.isFinite(order.price) || !(order.price! > 0))) return 'invalid limit price';
    if (order.type === 'STOP' && (!Number.isFinite(order.stopPrice) || !(order.stopPrice! > 0))) return 'invalid stop price';
    if (order.side === 'SELL') {
      const reserved = [...this._orders.values()].filter(o => o.id !== excludeOrderId && o.symbol === order.symbol
        && o.side === 'SELL' && ['PENDING', 'PARTIALLY_FILLED'].includes(o.status))
        .reduce((sum, o) => sum + o.quantity - o.filledQuantity, 0);
      if (order.quantity! - (order.filledQuantity || 0) > (this._positions.get(order.symbol!)?.quantity ?? 0) - reserved) {
        return 'SELL quantity exceeds unreserved held quantity - long-only, no shorting';
      }
    }
    return null;
  }

  constructor(initialCash = 100000) {
    this.initialCash = initialCash;
    this.cash = initialCash;
  }

  // G5 (ARGUS_CRYPTO_TRADING_REDESIGN_PLAN.md, 2026-09-28): durable restart recovery. Hydrates the
  // in-memory Maps (kept as a write-through cache for tick()'s hot synchronous loop) from
  // crypto_paper_broker_state/_positions/_orders. A fresh deployment with no prior state persists
  // its own starting snapshot on first boot rather than silently staying unpersisted until the
  // first real mutation - so even an untouched broker survives a restart identically.
  async initialize(): Promise<void> {
    const stateRow = db.select().from(cryptoPaperBrokerState).where(eq(cryptoPaperBrokerState.id, STATE_ROW_ID)).get();
    if (stateRow) {
      this.cash = stateRow.cash;
      this._realizedPnl = stateRow.realizedPnl;
      this.initialCash = stateRow.initialCash;
    } else {
      db.insert(cryptoPaperBrokerState).values({
        id: STATE_ROW_ID, cash: this.cash, initialCash: this.initialCash, realizedPnl: this._realizedPnl,
        updatedAt: new Date().toISOString(),
      }).run();
    }

    const positionRows = db.select().from(cryptoPaperPositions).all();
    for (const row of positionRows) {
      this._positions.set(row.symbol, {
        symbol: row.symbol, quantity: row.quantity, entryPrice: row.entryPrice,
        // currentPrice/marketValue/unrealizedPnl are derived display fields, recomputed by the
        // next real tick() against a fresh price - never persisted, never stale-restored as if
        // they were a live valuation from before the restart.
        currentPrice: row.entryPrice, marketValue: row.entryPrice * row.quantity, unrealizedPnl: 0, unrealizedPnlPercent: 0,
        entryFees: row.entryFees,
      });
    }

    const orderRows = db.select().from(cryptoPaperOrders).all();
    for (const row of orderRows) {
      const order: Order = {
        id: row.id, clientOrderId: row.clientOrderId ?? undefined, symbol: row.symbol,
        side: row.side as Order['side'], type: row.type as Order['type'], status: row.status as Order['status'],
        quantity: row.quantity, filledQuantity: row.filledQuantity,
        price: row.price ?? undefined, stopPrice: row.stopPrice ?? undefined, averageFillPrice: row.averageFillPrice ?? undefined,
        createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt),
      };
      if (row.rejectionReason) (order as any).rejectionReason = row.rejectionReason;
      this._orders.set(order.id, order);
      if (row.clientOrderId) this._clientOrderIdIndex.set(row.clientOrderId, order.id);
    }

    console.log(`[CryptoPaperBroker] Initialized (PAPER only - no real crypto venue is reachable through this adapter). Restored ${positionRows.length} position(s), ${orderRows.length} order(s) from durable state.`);
  }

  /** Persists the account-level singleton row (cash/realizedPnl) - always called inside the same
   *  transaction as any position/order mutation it accompanies, never on its own mid-fill. */
  private persistState(): void {
    db.update(cryptoPaperBrokerState).set({
      cash: this.cash, realizedPnl: this._realizedPnl, updatedAt: new Date().toISOString(),
    }).where(eq(cryptoPaperBrokerState.id, STATE_ROW_ID)).run();
  }

  private persistOrder(order: Order): void {
    const row = orderToRow(order);
    db.insert(cryptoPaperOrders).values(row)
      .onConflictDoUpdate({ target: cryptoPaperOrders.id, set: row }).run();
  }

  private persistPosition(symbol: string): void {
    const pos = this._positions.get(symbol);
    if (!pos) {
      db.delete(cryptoPaperPositions).where(eq(cryptoPaperPositions.symbol, symbol)).run();
      return;
    }
    const row = { symbol, quantity: pos.quantity, entryPrice: pos.entryPrice, entryFees: pos.entryFees, updatedAt: new Date().toISOString() };
    db.insert(cryptoPaperPositions).values(row)
      .onConflictDoUpdate({ target: cryptoPaperPositions.symbol, set: row }).run();
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
      this.persistOrder(order);
      return order;
    };

    if (!instrument || !instrument.enabledForPaper) {
      return rejected(`unregistered or not-paper-enabled crypto instrument: ${symbol}`);
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return rejected(`invalid quantity: ${orderData.quantity}`);
    }
    const invalid = this.validateOrder({ ...orderData, symbol, quantity });
    if (invalid) return rejected(invalid);
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
    this.persistOrder(newOrder);
    return newOrder;
  }

  async modifyOrder(orderId: string, updates: Partial<Order>): Promise<Order> {
    const order = this._orders.get(orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'PENDING') throw new Error('Cannot modify a non-pending order');
    const allowed = new Set(['quantity', 'price', 'stopPrice']);
    if (Object.keys(updates).some(key => !allowed.has(key))) throw new Error('Cannot modify protected order fields');
    const amended = { ...order, ...updates };
    const invalid = this.validateOrder(amended, orderId);
    if (invalid || amended.quantity < order.filledQuantity) throw new Error(invalid || 'Quantity below executed quantity');
    Object.assign(order, updates);
    order.updatedAt = new Date();
    this.persistOrder(order);
    return order;
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    const order = this._orders.get(orderId);
    if (!order) return false;
    if (order.status !== 'PENDING' && order.status !== 'PARTIALLY_FILLED') return false;
    order.status = 'CANCELED';
    order.updatedAt = new Date();
    this.persistOrder(order);
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
        if ((order.side === 'SELL' && fillPrice <= order.stopPrice) || (order.side === 'BUY' && fillPrice >= order.stopPrice)) this.triggeredStops.add(order.id);
        shouldEvaluate = this.triggeredStops.has(order.id);
      }
      if (!shouldEvaluate) continue;

      const remainingQuantity = order.quantity - order.filledQuantity;
      const remainingNotional = remainingQuantity * fillPrice;
      const availableNotional = order.side === 'SELL' ? (this._positions.get(order.symbol)?.quantity ?? 0) * fillPrice : remainingNotional;
      const fillableNotionalThisTick = Math.min(remainingNotional, assumptions.maxFillNotionalPerTick, availableNotional);
      const fillQuantityThisTick = fillableNotionalThisTick / fillPrice;
      const fee = fillableNotionalThisTick * feeRate;

      if (order.side === 'BUY') {
        const totalCost = fillableNotionalThisTick + fee;
        if (this.cash < totalCost) {
          order.status = 'REJECTED';
          (order as any).rejectionReason = 'insufficient paper cash at fill time';
          order.updatedAt = new Date();
          this.persistOrder(order);
          continue;
        }
      } else {
        // SELL - already validated at placeOrder() time to not exceed the position held then, but
        // re-validate here too (a concurrent SELL on the same symbol could have reduced it since).
        const heldQty = this._positions.get(order.symbol)?.quantity ?? 0;
        if (Math.min(fillQuantityThisTick, heldQty) <= 0) {
          order.status = 'REJECTED';
          (order as any).rejectionReason = 'no remaining position to sell at fill time';
          order.updatedAt = new Date();
          this.persistOrder(order);
          continue;
        }
      }

      // G5 (2026-09-28): the cash/position/order mutation for this one fill is applied and
      // persisted together as a single atomic unit - a crash between two different orders' fills
      // within the same tick() call leaves the already-completed fill durably recorded and the
      // not-yet-reached one untouched (still PENDING/PARTIALLY_FILLED, safely re-evaluated next
      // tick), never a half-applied fill (e.g. cash debited but the order/position not updated).
      db.transaction(() => {
        if (order.side === 'BUY') {
          const totalCost = fillableNotionalThisTick + fee;
          this.cash -= totalCost;
          const pos = this._positions.get(order.symbol);
          if (pos) {
            const newQty = pos.quantity + fillQuantityThisTick;
            const newTotalCost = pos.entryPrice * pos.quantity + fillableNotionalThisTick;
            pos.entryPrice = newTotalCost / newQty;
            pos.quantity = newQty;
            pos.entryFees += fee;
          } else {
            this._positions.set(order.symbol, {
              symbol: order.symbol,
              quantity: fillQuantityThisTick,
              entryPrice: fillPrice,
              currentPrice: fillPrice,
              marketValue: fillQuantityThisTick * fillPrice,
              unrealizedPnl: 0,
              unrealizedPnlPercent: 0,
              entryFees: fee,
            });
          }
        } else {
          const pos = this._positions.get(order.symbol);
          const heldQty = pos?.quantity ?? 0;
          const sellQty = Math.min(fillQuantityThisTick, heldQty);
          const proceeds = sellQty * fillPrice - fee;
          this.cash += proceeds;
          if (pos) {
            const allocatedEntryFee = pos.entryFees * (sellQty / pos.quantity);
            const realizedThisFill = (fillPrice - pos.entryPrice) * sellQty - fee - allocatedEntryFee;
            pos.entryFees -= allocatedEntryFee;
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

        this.persistState();
        this.persistPosition(order.symbol);
        this.persistOrder(order);
      });
    }

    for (const [symbol, pos] of this._positions) {
      const currentPrice = currentPrices[symbol];
      if (Number.isFinite(currentPrice) && currentPrice > 0) {
        pos.currentPrice = currentPrice;
        pos.marketValue = currentPrice * pos.quantity;
        const totalCost = pos.entryPrice * pos.quantity + pos.entryFees;
        pos.unrealizedPnl = pos.marketValue - totalCost;
        pos.unrealizedPnlPercent = totalCost !== 0 ? pos.unrealizedPnl / totalCost : 0;
      }
    }
  }

  /** Test/diagnostic only - real callers use portfolio()/positions(). */
  getInitialCash(): number { return this.initialCash; }
}
