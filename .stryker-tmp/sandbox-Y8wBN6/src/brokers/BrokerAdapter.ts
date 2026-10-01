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
// @ts-nocheck


export interface Order {
  id: string;
  // Phase 1 (ARGUS_SAFETY_HARDENING_REPORT.md) - optional client-supplied idempotency key, passed
  // into placeOrder() and honored by AlpacaBroker (mapped to Alpaca's real `client_order_id`
  // field, which Alpaca itself deduplicates on). Additive - a broker adapter that doesn't support
  // one simply ignores it, exactly like every other optional field on this interface already used
  // that way (trailPercent, takeProfitPrice, etc. below).
  clientOrderId?: string;
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
  /** Extended-Hours Execution Policy (2026-09-05). Requests premarket/after-hours eligibility for
   *  this order - additive, defaults to unset/false everywhere. An adapter that doesn't honor it
   *  (BrokerCapabilities.extendedHoursOrders === false) simply ignores it and the order behaves
   *  exactly as it always has, matching every other optional field on this interface. */
  extendedHours?: boolean;
  /** Canonical Cost Model / Economic Attribution (Priority 13, 2026-09-23). Real, broker-reported
   *  aggregate commission for THIS order so far, when the adapter actually has one (e.g. IBKR's
   *  commissionReport, attributed via execId - see IbkrSocketSession.getAggregateCommissionForOrder()).
   *  Undefined means "this adapter has no real commission evidence for this order yet" - never a
   *  zero default. An adapter that doesn't support real commission reporting simply omits this
   *  field, exactly like every other optional field on this interface. */
  commission?: number;
}

export interface Position {
  symbol: string;
  quantity: number;
  // F26 (2026-09-27): entryPrice/currentPrice/marketValue/unrealizedPnl/unrealizedPnlPercent are
  // `number | null` - null means genuinely UNAVAILABLE (a real pricing/cost-basis lookup failed or
  // does not exist for this instrument), never a fabricated numeric zero. quantity is never
  // affected - a real held quantity is always reported even when it cannot be valued. Every
  // existing adapter that always successfully resolves these values is unaffected (still returns
  // real numbers with valuationStatus implicitly 'VALUED'); this is additive, not a behavior
  // change for adapters that don't set valuationStatus explicitly.
  entryPrice: number | null;
  currentPrice: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPercent: number | null;
  /** Explicit valuation-completeness label, matching the CostQuality/UNAVAILABLE convention in
   *  canonicalCostModel.ts. Undefined (not set by an adapter) is treated as 'VALUED' for backward
   *  compatibility - only adapters with a real known-incomplete-pricing case (currently
   *  CoinbaseBroker) need to set this. 'UNAVAILABLE' means at least one of the numeric fields above
   *  is null and must not be treated as a real zero economic fact by any consumer. */
  valuationStatus?: 'VALUED' | 'UNAVAILABLE';
}

export interface Portfolio {
  cash: number;
  buyingPower: number;
  equity: number;
  positions: Position[];
  dailyPnl?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  /** F26: 'PARTIAL' when one or more positions carry valuationStatus 'UNAVAILABLE' - signals that
   *  `equity`/`unrealizedPnl` are computed from an incomplete valuation set (unpriceable positions
   *  contribute 0 to the sums, which UNDERSTATES true exposure rather than fabricating a
   *  plausible-looking total). Undefined/omitted means every position was fully valued. */
  valuationStatus?: 'VALUED' | 'PARTIAL';
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
  // True only for adapters whose authenticated session cannot be established or refreshed
  // programmatically end-to-end (e.g. IBKR's Client Portal Gateway requires a human to complete
  // browser 2FA login roughly every 24h - there is no official headless bypass). False for
  // adapters that authenticate purely via API key/secret with no recurring human step.
  requiresManualReauth: boolean;
  /** Extended-Hours Execution Policy (2026-09-05). True only for an adapter whose placeOrder()
   *  actually constructs a real extended-hours-eligible order (Alpaca's extended_hours flag, IB's
   *  outsideRth flag) when Order.extendedHours is set - never a claim of theoretical broker-API
   *  support the adapter code doesn't back up, same discipline as canPlaceOrders above. Defaults
   *  to false for every existing adapter until this pass's own broker-specific wiring lands. */
  extendedHoursOrders: boolean;
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
  closePosition(symbol: string): Promise<boolean>;

  tick?(currentPrices: Record<string, number>): void;

  // Phase 1 (ARGUS_SAFETY_HARDENING_REPORT.md) - optional, since not every broker adapter
  // supports lookup-by-client-order-id. AlpacaBroker implements it (mapped to Alpaca's real
  // client_order_id query param). Used by OrderManagement's crash-recovery reconciliation to
  // definitively answer "did the broker actually receive this order?" for a local row left in a
  // PENDING or possibly-wrongly-REJECTED state - never a guess from local state alone.
  getOrderByClientOrderId?(clientOrderId: string): Promise<Order | null>;
}

export function brokerSupports(broker: BrokerPlugin, capability: keyof BrokerCapabilities): boolean {
  return !!broker.getCapabilities()[capability];
}