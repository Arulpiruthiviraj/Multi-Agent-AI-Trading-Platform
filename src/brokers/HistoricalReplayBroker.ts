/**
 * Isolated in-memory broker for historical replay. Never LIVE. Never Alpaca/IBKR/Coinbase.
 * Fills are deterministic NEXT_BAR_OPEN + configured slippage/spread. Zero slippage is not the only path.
 */
import crypto from 'crypto';
import { BrokerPlugin, BrokerCapabilities, Order, Portfolio, Position } from './BrokerAdapter';
import type { ReplayCostProfile } from '../server/replay/replaySafety';
import { classifyMarketSession, sessionAllowsFills } from '../server/replay/marketSession';

export class HistoricalReplayBroker implements BrokerPlugin {
  id = 'historical_replay';
  name = 'Argus Historical Replay Simulator';
  isPaper = true;

  private cash: number;
  private _positions = new Map<string, Position>();
  private _orders = new Map<string, Order>();
  private realizedPnl = 0;
  private feesPaid = 0;
  private slippagePaid = 0;
  nextFillPrice = new Map<string, number>();
  /** Fill bar's own reported volume - used only for the volume-participation cap, never for pricing. */
  nextFillVolume = new Map<string, number>();
  clockNowMs = 0;
  timezone = 'America/New_York';
  extendedHours = false;
  shortSelling = false;
  fractional = false;
  costs: ReplayCostProfile;
  liveRefused = false;
  /** Fraction of the fill bar's volume a single order may consume. null/undefined disables the cap entirely (unbounded, matching pre-existing behavior). */
  maxVolumeParticipationPct: number | null;

  constructor(opts: {
    initialCash: number;
    costs: ReplayCostProfile;
    timezone: string;
    extendedHours: boolean;
    shortSelling: boolean;
    fractional: boolean;
    maxVolumeParticipationPct?: number | null;
  }) {
    this.cash = opts.initialCash;
    this.costs = opts.costs;
    this.timezone = opts.timezone;
    this.extendedHours = opts.extendedHours;
    this.shortSelling = opts.shortSelling;
    this.fractional = opts.fractional;
    this.maxVolumeParticipationPct = opts.maxVolumeParticipationPct ?? null;
  }

  /**
   * Caps a requested quantity at maxVolumeParticipationPct of the fill bar's own reported volume.
   * Returns the requested quantity unchanged if no volume figure or no cap is configured for this
   * symbol/order (matches pre-existing unbounded behavior exactly - additive, not a behavior
   * change for any caller that doesn't opt in).
   */
  private applyVolumeParticipationCap(symbol: string, requestedQty: number): number {
    if (this.maxVolumeParticipationPct == null) return requestedQty;
    const barVolume = this.nextFillVolume.get(symbol);
    if (typeof barVolume !== 'number' || !(barVolume > 0)) return requestedQty;
    const cap = Math.floor(barVolume * this.maxVolumeParticipationPct);
    return Math.min(requestedQty, cap);
  }

  async initialize() {}
  async validateCredentials() { return true; }
  paperTrading() {}
  liveTrading() {
    this.liveRefused = true;
    throw new Error('HistoricalReplayBroker refuses LIVE. Replay is SIMULATION ONLY.');
  }
  getCapabilities(): BrokerCapabilities {
    return {
      canPlaceOrders: true,
      canCancelOrders: true,
      paperTrading: true,
      liveTrading: false,
      usEquities: true,
      canadianEquities: false,
      crypto: false,
      options: false,
      shortSelling: this.shortSelling,
      streamingMarketData: false,
      requiresManualReauth: false,
    };
  }
  async health() { return 'Healthy'; }
  async connect() { return this.authenticate(); }
  async authenticate() { return true; }
  async disconnect() {}
  async account() { return { status: 'REPLAY', id: 'historical-replay' }; }

  markToMarket(prices: Record<string, number>) {
    for (const [sym, pos] of this._positions) {
      const px = prices[sym];
      if (typeof px !== 'number' || !(px > 0)) continue;
      pos.currentPrice = px;
      pos.marketValue = pos.quantity * px;
      pos.unrealizedPnl = (px - pos.entryPrice) * pos.quantity;
      pos.unrealizedPnlPercent = pos.entryPrice > 0 ? pos.unrealizedPnl / (pos.entryPrice * pos.quantity) : 0;
    }
  }

  applyFillPrice(raw: number): { fill: number; slippage: number; spread: number } {
    const spread = raw * (this.costs.spreadBps / 10_000);
    const slip = raw * (this.costs.slippageBps / 10_000);
    return { fill: raw + spread / 2 + slip, slippage: slip, spread: spread / 2 };
  }

  async portfolio(): Promise<Portfolio> {
    const posList = Array.from(this._positions.values());
    const equity = this.cash + posList.reduce((a, p) => a + p.marketValue, 0);
    return {
      cash: this.cash,
      buyingPower: this.cash,
      equity,
      positions: posList,
      realizedPnl: this.realizedPnl,
      unrealizedPnl: posList.reduce((a, p) => a + p.unrealizedPnl, 0),
    };
  }

  async getBuyingPower() { return this.cash; }
  async orders() { return Array.from(this._orders.values()); }
  async positions() { return Array.from(this._positions.values()); }

  snapshotCosts() {
    return { feesPaid: this.feesPaid, slippagePaid: this.slippagePaid, realizedPnl: this.realizedPnl, cash: this.cash };
  }

  async placeOrder(orderData: Partial<Order>): Promise<Order> {
    if (this.liveRefused) throw new Error('LIVE refused');
    const session = classifyMarketSession(this.clockNowMs, this.timezone, this.extendedHours);
    if (!sessionAllowsFills(session, this.extendedHours)) {
      const rejected: Order = {
        id: crypto.randomUUID(),
        symbol: orderData.symbol!,
        side: orderData.side!,
        type: orderData.type || 'MARKET',
        status: 'REJECTED',
        quantity: orderData.quantity || 0,
        filledQuantity: 0,
        createdAt: new Date(this.clockNowMs),
        updatedAt: new Date(this.clockNowMs),
      };
      this._orders.set(rejected.id, rejected);
      return rejected;
    }
    const qtyReq = orderData.quantity || 0;
    const requestedQty = this.fractional ? qtyReq : Math.floor(qtyReq);
    if (!(requestedQty > 0)) {
      return {
        id: crypto.randomUUID(),
        symbol: orderData.symbol!,
        side: orderData.side!,
        type: 'MARKET',
        status: 'REJECTED',
        quantity: 0,
        filledQuantity: 0,
        createdAt: new Date(this.clockNowMs),
        updatedAt: new Date(this.clockNowMs),
      };
    }
    const qty = this.applyVolumeParticipationCap(orderData.symbol!, requestedQty);
    if (!(qty > 0)) {
      return {
        id: crypto.randomUUID(),
        symbol: orderData.symbol!,
        side: orderData.side!,
        type: 'MARKET',
        status: 'REJECTED',
        quantity: requestedQty,
        filledQuantity: 0,
        createdAt: new Date(this.clockNowMs),
        updatedAt: new Date(this.clockNowMs),
      };
    }
    const isPartial = qty < requestedQty;
    if (orderData.side === 'SELL' && qtyReq < 0 && !this.shortSelling) {
      throw new Error('SHORT_DISABLED');
    }
    const raw = this.nextFillPrice.get(orderData.symbol!) ?? orderData.price;
    if (typeof raw !== 'number' || !(raw > 0)) {
      throw new Error('REPLAY_FILL_PRICE_UNAVAILABLE');
    }
    const priced = this.applyFillPrice(raw);
    const commission = this.costs.commissionPerShare * qty;
    const notional = priced.fill * qty;
    if (orderData.side === 'BUY') {
      if (this.cash < notional + commission) {
        return {
          id: crypto.randomUUID(),
          symbol: orderData.symbol!,
          side: 'BUY',
          type: 'MARKET',
          status: 'REJECTED',
          quantity: qty,
          filledQuantity: 0,
          createdAt: new Date(this.clockNowMs),
          updatedAt: new Date(this.clockNowMs),
        };
      }
      this.cash -= notional + commission;
      this.feesPaid += commission;
      this.slippagePaid += priced.slippage * qty;
      const existing = this._positions.get(orderData.symbol!);
      if (existing) {
        const newQty = existing.quantity + qty;
        existing.entryPrice = (existing.entryPrice * existing.quantity + priced.fill * qty) / newQty;
        existing.quantity = newQty;
        existing.currentPrice = priced.fill;
        existing.marketValue = newQty * priced.fill;
      } else {
        this._positions.set(orderData.symbol!, {
          symbol: orderData.symbol!,
          quantity: qty,
          entryPrice: priced.fill,
          currentPrice: priced.fill,
          marketValue: notional,
          unrealizedPnl: 0,
          unrealizedPnlPercent: 0,
        });
      }
    } else {
      const existing = this._positions.get(orderData.symbol!);
      if (!existing || existing.quantity < qty) {
        if (!this.shortSelling) {
          return {
            id: crypto.randomUUID(),
            symbol: orderData.symbol!,
            side: 'SELL',
            type: 'MARKET',
            status: 'REJECTED',
            quantity: qty,
            filledQuantity: 0,
            createdAt: new Date(this.clockNowMs),
            updatedAt: new Date(this.clockNowMs),
          };
        }
      }
      const sellQty = Math.min(qty, existing?.quantity ?? 0);
      const proceeds = priced.fill * sellQty;
      this.cash += proceeds - commission;
      this.feesPaid += commission;
      this.slippagePaid += priced.slippage * sellQty;
      if (existing && sellQty > 0) {
        this.realizedPnl += (priced.fill - existing.entryPrice) * sellQty - commission;
        existing.quantity -= sellQty;
        if (existing.quantity <= 0) this._positions.delete(orderData.symbol!);
        else {
          existing.marketValue = existing.quantity * priced.fill;
          existing.currentPrice = priced.fill;
        }
      }
    }
    const filled: Order = {
      id: orderData.clientOrderId || crypto.randomUUID(),
      clientOrderId: orderData.clientOrderId,
      symbol: orderData.symbol!,
      side: orderData.side!,
      type: orderData.type || 'MARKET',
      status: isPartial ? 'PARTIALLY_FILLED' : 'FILLED',
      quantity: requestedQty,
      filledQuantity: qty,
      averageFillPrice: priced.fill,
      price: priced.fill,
      createdAt: new Date(this.clockNowMs),
      updatedAt: new Date(this.clockNowMs),
    };
    this._orders.set(filled.id, filled);
    return filled;
  }

  async modifyOrder() { throw new Error('Replay modifyOrder unsupported'); }
  async cancelOrder(orderId: string) {
    const o = this._orders.get(orderId);
    if (!o || o.status !== 'PENDING') return false;
    o.status = 'CANCELED';
    return true;
  }
  async closePosition(symbol: string) {
    const pos = this._positions.get(symbol);
    if (!pos || pos.quantity <= 0) return false;
    await this.placeOrder({ symbol, side: 'SELL', type: 'MARKET', quantity: pos.quantity });
    return true;
  }
}
