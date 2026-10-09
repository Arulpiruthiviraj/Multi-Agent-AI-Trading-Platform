/**
 * Isolated in-memory broker for historical replay. Never LIVE. Never Alpaca/IBKR/Coinbase.
 * Fills are deterministic NEXT_BAR_OPEN + configured slippage/spread. Zero slippage is not the only path.
 */
import crypto from 'crypto';
import { BrokerPlugin, BrokerCapabilities, Order, Portfolio, Position } from './BrokerAdapter';
import type { ReplayCostProfile } from '../server/replay/replaySafety';
import { classifyMarketSession, sessionAllowsFills } from '../server/replay/marketSession';
import {
  evictOldestTerminalOrdersIfOverCap,
  isPaperBrokerOrderEvictionEnabled,
  resolvePaperBrokerOrderRegistryMax,
} from './brokerMemory';

export class HistoricalReplayBroker implements BrokerPlugin {
  id = 'historical_replay';
  name = 'Argus Historical Replay Simulator';
  isPaper = true;

  private cash: number;
  private _positions = new Map<string, Position>();
  private _orders = new Map<string, Order>();
  /** Orders currently PARTIALLY_FILLED with a real remainder still to fill - see
   *  advanceWorkingOrders()'s own doc comment for the full multi-bar completion mechanism.
   *  lastAdvancedAtMs guards against a duplicate/repeated call for the SAME bar double- or
   *  triple-consuming that one bar's volume cap (found live, 2026-09-16: two advanceWorkingOrders()
   *  calls at an unchanged clockNowMs filled 300 shares against a 100-share single-bar cap before
   *  this guard existed - a real duplicate-market-event class of bug, not a hypothetical one). */
  private _workingOrders = new Map<string, { symbol: string; side: 'BUY' | 'SELL'; remainingQty: number; filledSoFar: number; totalNotionalFilled: number; lastAdvancedAtMs: number | null }>();
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
  /**
   * Unconditionally, statelessly throws on every call - this broker can never enter LIVE mode.
   * Deliberately has NO persistent side effect (no "poison flag" on this instance): the isolation
   * self-check (SyntheticSimulationSafety.ts's assertActiveSessionIsSynthetic()) legitimately calls
   * this method on the SAME broker instance the session goes on to place real replay orders
   * through, purely to prove the throw - not to actually arm live mode. A one-way stateful flag
   * here previously made that legitimate proof call permanently break every subsequent placeOrder()
   * on the same instance (found 2026-09-15, CERTIFIED_BULLISH_ENTRY_EXIT: a real RiskEngine-approved
   * order threw "LIVE refused" even though liveTrading() was never meant to be armed). The
   * unconditional throw alone already makes going live impossible on every call, with or without
   * memory of a prior call.
   */
  liveTrading() {
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
      // sessionAllowsFills()/extendedHours are already real replay-config concepts, but
      // placeOrder() never reads Order.extendedHours - false here would be misleading only if the
      // replay config's own extendedHours flag were the same thing; it governs FILL ELIGIBILITY by
      // session (already handled), not a broker-specific order-type flag. False is honest either way.
      extendedHoursOrders: false,
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
  /** 2026-10-08 defect hunt (D3): _orders grew one entry per replay order, never evicted -
   *  the Oct-8 memory hunt bounded the other paper brokers but missed the replay broker.
   *  Same evictOldestTerminalOrdersIfOverCap treatment: non-terminal orders are never evicted,
   *  and replay rows are durable in the trades/fills DB tables anyway. */
  private evictOrdersIfOverCap(): void {
    if (!isPaperBrokerOrderEvictionEnabled()) return;
    evictOldestTerminalOrdersIfOverCap(this._orders, resolvePaperBrokerOrderRegistryMax());
  }

  async orders() { return Array.from(this._orders.values()); }
  async positions() { return Array.from(this._positions.values()); }

  snapshotCosts() {
    return { feesPaid: this.feesPaid, slippagePaid: this.slippagePaid, realizedPnl: this.realizedPnl, cash: this.cash };
  }

  async placeOrder(orderData: Partial<Order>): Promise<Order> {
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
      this.evictOrdersIfOverCap();
      return rejected;
    }
    const qtyReq = orderData.quantity || 0;
    const requestedQty = this.fractional ? qtyReq : Math.floor(qtyReq);
    // 2026-10-08 defect hunt (D5): also reject non-finite quantities (Infinity passed the
    // old > 0 check). Matches the Coinbase-style finite > 0 discipline of the real adapters.
    if (!Number.isFinite(requestedQty) || !(requestedQty > 0)) {
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
    let qty = this.applyVolumeParticipationCap(orderData.symbol!, requestedQty);
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
    let isPartial = qty < requestedQty;
    // P1-16: true only when a SELL's fill was capped by insufficient position (not by volume) -
    // see the SELL branch below, which reassigns qty/isPartial to the economically-real amount.
    let positionLimitedSell = false;
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
      // P1-16 (2026-10-04 remediation): this broker has no negative-inventory/short-position
      // tracking anywhere (confirmed - `shortSelling` only ever gates whether an oversell is
      // rejected, never creates a short position). Previously, when shortSelling allowed an
      // oversell past the held quantity, cash/P&L/position correctly used sellQty (clamped to the
      // held long) but the RETURNED order still reported filledQuantity = the full volume-capped
      // qty - a phantom fill where the ledger and the broker's own economics disagreed. Commission
      // here is rescoped to sellQty too (it was computed from the pre-clamp qty above, which would
      // have overcharged commission on shares that were never actually sold).
      const sellQty = Math.min(qty, existing?.quantity ?? 0);
      const sellCommission = this.costs.commissionPerShare * sellQty;
      const proceeds = priced.fill * sellQty;
      this.cash += proceeds - sellCommission;
      this.feesPaid += sellCommission;
      this.slippagePaid += priced.slippage * sellQty;
      if (existing && sellQty > 0) {
        this.realizedPnl += (priced.fill - existing.entryPrice) * sellQty - sellCommission;
        existing.quantity -= sellQty;
        if (existing.quantity <= 0) this._positions.delete(orderData.symbol!);
        else {
          existing.marketValue = existing.quantity * priced.fill;
          existing.currentPrice = priced.fill;
        }
      }
      // qty (the volume-participation cap) is reassigned to the economically-real fill quantity so
      // the single shared Order-construction/working-order-registration path below (used by BUY
      // too) reports and tracks the truthful amount for a position-insufficient SELL.
      positionLimitedSell = sellQty < qty;
      qty = sellQty;
      isPartial = qty < requestedQty;
    }
    const filled: Order = {
      id: orderData.clientOrderId || crypto.randomUUID(),
      clientOrderId: orderData.clientOrderId,
      symbol: orderData.symbol!,
      side: orderData.side!,
      type: orderData.type || 'MARKET',
      status: qty <= 0 ? 'REJECTED' : isPartial ? 'PARTIALLY_FILLED' : 'FILLED',
      quantity: requestedQty,
      filledQuantity: qty,
      averageFillPrice: priced.fill,
      price: priced.fill,
      createdAt: new Date(this.clockNowMs),
      updatedAt: new Date(this.clockNowMs),
    };
    this._orders.set(filled.id, filled);
    this.evictOrdersIfOverCap();
    // Multi-bar partial-fill completion (2026-09-16, certification follow-up). Previously a
    // PARTIALLY_FILLED order here was permanently stuck at its first-bar filled quantity forever -
    // a real, disclosed simulator limitation (config/replaySafety.json's own
    // partialFillModelDescription already said so), unlike a real broker (or this codebase's own
    // production-path Alpaca/IBKR adapters) which naturally keeps filling a resting order as more
    // liquidity becomes available. Registering the remainder here lets advanceWorkingOrders() (see
    // below) top it up on later bars using the exact same volume-cap/pricing/cash/position logic
    // this method already uses - never a different, parallel fill model.
    //
    // A SELL left under-filled by insufficient position (not volume) is NOT registered as a
    // working order: this simulator has no short-position model, so there is no real mechanism by
    // which the remainder could ever "become fillable" later - registering it would just recreate
    // the same phantom-fill-shaped problem on a delay.
    if (isPartial && qty > 0 && !positionLimitedSell) {
      this._workingOrders.set(filled.id, {
        symbol: orderData.symbol!,
        side: orderData.side!,
        remainingQty: requestedQty - qty,
        filledSoFar: qty,
        totalNotionalFilled: priced.fill * qty,
        // The order's OWN entry fill already consumed this bar (clockNowMs) - record it so an
        // advanceWorkingOrders() call still at this same bar (a duplicate event, or a caller that
        // advances before the clock genuinely moves) correctly no-ops instead of consuming the same
        // bar's volume a second time.
        lastAdvancedAtMs: this.clockNowMs,
      });
    }
    return filled;
  }

  /**
   * Advances every still-open PARTIALLY_FILLED order by whatever additional quantity the CURRENT
   * bar's volume cap and cash/position constraints allow - the real multi-bar completion mechanism
   * `placeOrder()`'s own header comment above now points to. Callers (the synthetic session engine,
   * per-bar; or a test driving the broker directly) call this once per bar, exactly the same way a
   * real broker's own resting-order matching engine would revisit a working order as new liquidity
   * arrives. Never fills more than the cap in a single call - a still-insufficient bar simply leaves
   * the order PARTIALLY_FILLED for the next call, the same honest "no more liquidity yet" outcome
   * the original single-shot fill already produced, just no longer permanently final. Reuses the
   * SAME weighted-average-price, cash, and position-update math `placeOrder()` uses for the initial
   * fill - never a second, parallel accounting path.
   */
  advanceWorkingOrders(): void {
    for (const [orderId, w] of this._workingOrders) {
      if (!(w.remainingQty > 0)) { this._workingOrders.delete(orderId); continue; }
      // Duplicate-event guard: this exact bar (clockNowMs unchanged since the last successful
      // advance/entry-fill for this order) has already had its volume consumed for this order -
      // a repeated call here must no-op, never fill the same bar's cap a second time.
      if (w.lastAdvancedAtMs === this.clockNowMs) continue;
      const capQty = this.applyVolumeParticipationCap(w.symbol, w.remainingQty);
      if (!(capQty > 0)) continue; // no additional liquidity this bar - try again next advance
      const raw = this.nextFillPrice.get(w.symbol);
      if (typeof raw !== 'number' || !(raw > 0)) continue; // no fresh price this bar - try again next advance
      const priced = this.applyFillPrice(raw);

      let actualQty = 0;
      if (w.side === 'BUY') {
        const commission = this.costs.commissionPerShare * capQty;
        const notional = priced.fill * capQty;
        if (this.cash < notional + commission) continue; // insufficient cash this bar - try again next advance
        this.cash -= notional + commission;
        this.feesPaid += commission;
        this.slippagePaid += priced.slippage * capQty;
        actualQty = capQty;
        const existing = this._positions.get(w.symbol);
        if (existing) {
          const newQty = existing.quantity + actualQty;
          existing.entryPrice = (existing.entryPrice * existing.quantity + priced.fill * actualQty) / newQty;
          existing.quantity = newQty;
          existing.currentPrice = priced.fill;
          existing.marketValue = newQty * priced.fill;
        } else {
          this._positions.set(w.symbol, {
            symbol: w.symbol, quantity: actualQty, entryPrice: priced.fill, currentPrice: priced.fill,
            marketValue: notional, unrealizedPnl: 0, unrealizedPnlPercent: 0,
          });
        }
      } else {
        const existing = this._positions.get(w.symbol);
        actualQty = Math.min(capQty, existing?.quantity ?? 0);
        if (!(actualQty > 0)) continue; // no remaining position to sell this bar - try again next advance
        const commission = this.costs.commissionPerShare * actualQty;
        const proceeds = priced.fill * actualQty;
        this.cash += proceeds - commission;
        this.feesPaid += commission;
        this.slippagePaid += priced.slippage * actualQty;
        this.realizedPnl += (priced.fill - existing!.entryPrice) * actualQty - commission;
        existing!.quantity -= actualQty;
        if (existing!.quantity <= 0) this._positions.delete(w.symbol);
        else { existing!.marketValue = existing!.quantity * priced.fill; existing!.currentPrice = priced.fill; }
      }

      w.remainingQty -= actualQty;
      w.filledSoFar += actualQty;
      w.totalNotionalFilled += priced.fill * actualQty;
      w.lastAdvancedAtMs = this.clockNowMs;
      const order = this._orders.get(orderId);
      if (order) {
        order.filledQuantity = w.filledSoFar;
        order.averageFillPrice = w.totalNotionalFilled / w.filledSoFar;
        order.price = order.averageFillPrice;
        order.status = w.remainingQty > 0 ? 'PARTIALLY_FILLED' : 'FILLED';
        order.updatedAt = new Date(this.clockNowMs);
      }
      if (!(w.remainingQty > 0)) this._workingOrders.delete(orderId);
    }
  }

  async modifyOrder() { throw new Error('Replay modifyOrder unsupported'); }
  async cancelOrder(orderId: string) {
    const o = this._orders.get(orderId);
    if (!o || (o.status !== 'PENDING' && o.status !== 'PARTIALLY_FILLED')) return false;
    this._workingOrders.delete(orderId);
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
