/**
 * IB Gateway / TWS TCP socket session via @stoqey/ib.
 * Orders still enter only through OMS → BrokerManager.getActiveBroker().placeOrder().
 * This module never opens a browser and never speaks Client Portal :5000.
 */
import {
  IBApi,
  EventName,
  SecType,
  OrderType,
  OrderAction,
  ErrorCode,
  BarSizeSetting,
  WhatToShow,
} from '@stoqey/ib';
import type { Contract } from '@stoqey/ib';
import { loadIbkrConnection, ibkrSocketPortCandidates, type IbkrConnectionConfig } from '../server/config/ibkrConnection';
import { continuousIntelligence } from '../server/config/continuousIntelligence';
import { findFirstOpenTcpPort } from './ibkrTcpProbe';
import type { Bar } from '../server/engines/backtest/HistoricalDataGateway';
import { ReconnectBackoff } from '../server/core/reconnectBackoff';
import {
  resolveIbkrContract,
  getCachedIbkrContractResolution,
  type ContractResolutionOutcome,
} from './ibkrContractResolution';

/**
 * Pure order-object construction, extracted from placeStockOrder() (2026-09-05, Extended-Hours
 * Execution Policy) so this real, safety-relevant construction logic is directly unit-testable
 * without a live/mocked IB socket connection - same pattern as this session's other extracted
 * pure functions (e.g. ChiefTraderAgent.loadJavaInstitutionalDebateContext, KronosInference.
 * computeKronosConfidence).
 */
export function buildIbkrOrder(orderId: number, opts: {
  side: 'BUY' | 'SELL';
  quantity: number;
  type: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
  limitPrice?: number;
  stopPrice?: number;
  account?: string;
  extendedHours?: boolean;
  /** Real crash-recovery fix (2026-09-09): set as IB's own `orderRef` field - a real, broker-side
   *  free-text tag (not a local-only value) that IB echoes back on every openOrder/orderStatus/
   *  execDetails event for this order, including after a full Argus process restart. This is what
   *  makes getTrackedOrderByClientOrderId() below actually work, closing the exact gap the
   *  2026-09-09 forensic audit found: OMS's own client_order_id contract previously did nothing at
   *  all for IBKR (real + broker-deduped for Alpaca only). IB's own limit is 100 characters -
   *  Argus's UUID-shaped trade ids (36 chars) fit with room to spare. */
  clientOrderId?: string;
}): any {
  let orderType = OrderType.MKT;
  if (opts.type === 'LIMIT') orderType = OrderType.LMT;
  else if (opts.type === 'STOP') orderType = OrderType.STP;
  else if (opts.type === 'STOP_LIMIT') orderType = OrderType.STP_LMT;

  const order: any = {
    orderId,
    action: opts.side === 'SELL' ? OrderAction.SELL : OrderAction.BUY,
    totalQuantity: opts.quantity,
    orderType,
    tif: 'DAY',
    account: opts.account || undefined,
    transmit: true,
  };
  if (opts.clientOrderId) {
    order.orderRef = opts.clientOrderId;
  }
  if (opts.type === 'LIMIT' || opts.type === 'STOP_LIMIT') {
    order.lmtPrice = opts.limitPrice;
  }
  if (opts.type === 'STOP' || opts.type === 'STOP_LIMIT') {
    order.auxPrice = opts.stopPrice;
  }
  // Extended-Hours Execution Policy (2026-09-05): outsideRth only honored for LIMIT - mission's
  // own "no blind market orders outside RTH" rule, matching AlpacaBroker's identical constraint.
  if (opts.extendedHours && opts.type === 'LIMIT') {
    order.outsideRth = true;
  }
  return order;
}

/**
 * Per-symbol subscription lifecycle state (2026-09-20 Sept-18 rejection-desync remediation;
 * 2026-09-21 Phase 2 acknowledgement-evidence hardening).
 *
 * Real, verified Sept-18 defect: `symbolToTicker` was set optimistically the instant `reqMktData()`
 * was called, before IBKR's response was known, and was only ever cleared by an explicit
 * unsubscribe/teardown - never by a rejection. `subscribeMarketData()`'s early-return-if-already-
 * tracked guard then meant a symbol IBKR explicitly rejected (354/10089) was never retried again
 * without an external trigger (confirmed live: 32 symbols starved 15:27-19:38 UTC on 2026-09-18,
 * ~4h11m, until an operator manually forced a resubscribe). `desiredMarketData` (the symbol is
 * still wanted) and this record's `state` (what IBKR most recently told us, or didn't) are
 * deliberately two separate concepts - a REJECTED_RETRYABLE symbol stays fully DESIRED the whole
 * time, exactly as that remediation required.
 *
 * Real, verified Phase 2 defect in the Sept-18 fix itself (post-fix adversarial audit,
 * 2026-09-21): the fix's own confirmation-timeout path treated 60s of silence (no tick, no error)
 * as equivalent to an explicit rejection, moving the symbol into RETRY_WAIT via a synthetic
 * errorCode=-1. Runtime verification of that fix happened to run at 2026-09-20 20:28 America/
 * New_York (confirmed: Sunday evening, fully closed market) - silence during a closed or thin
 * market is NOT evidence of a broker rejection. `ACKNOWLEDGED` is new: IBKR's own `marketDataType`
 * (fires "when the user has live-data permission for that instrument") and `tickReqParams`
 * ("returned immediately after a market-data request" for an entitled user) callbacks are real,
 * request-level evidence the request was accepted - stronger than waiting for a price to change,
 * and available well before market open. Neither callback is treated as proof of a FRESH live
 * price - `ACTIVE` still requires a genuine tick (field 1/2/4).
 */
type SubscriptionLifecycleState =
  | 'IDLE'
  | 'REQUESTING'
  | 'ACKNOWLEDGED'
  | 'ACTIVE'
  | 'REJECTED_RETRYABLE'
  | 'REJECTED_NONRETRYABLE'
  | 'RETRY_WAIT';

/** 2026-09-21 Phase 2: an ARGUS-internal observation, never an IBKR-issued error code. Kept
 *  strictly separate from lastErrorCode/lastErrorMessage (broker-issued codes only, e.g. 354/10089)
 *  - the exact separation the post-fix audit required after finding errorCode=-1 stored beside real
 *  broker codes. NO_ACKNOWLEDGEMENT is diagnostic only; it never by itself moves state out of
 *  REQUESTING or starts a retry-backoff countdown. */
type InternalFailureKind = 'NO_ACKNOWLEDGEMENT';

interface SubscriptionRecord {
  symbol: string;
  tickerId: number | null;
  state: SubscriptionLifecycleState;
  lastRequestAt: number | null;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  /** Broker-issued IBKR error code ONLY (e.g. 354, 10089, 200, 10197) - never a synthetic/internal
   *  value. See lastInternalFailureKind for ARGUS-generated conditions. */
  lastErrorCode: number | null;
  lastErrorMessage: string | null;
  retryCount: number;
  nextRetryAt: number | null;
  generation: number;
  /** 2026-09-21 Phase 2: set when IBKR's marketDataType or tickReqParams callback fired for this
   *  request - real, request-level evidence distinct from (and weaker than) a live tick. */
  lastAcknowledgedAt: number | null;
  acknowledgementKind: 'MARKET_DATA_TYPE' | 'TICK_REQ_PARAMS' | null;
  /** IBKR's own reported data type for this request: 1=real-time, 2=frozen, 3=delayed,
   *  4=delayed-frozen. Recorded honestly, never used to satisfy live-freshness requirements. */
  marketDataType: number | null;
  /** ARGUS-internal observation only - see InternalFailureKind's own doc comment. */
  lastInternalFailureKind: InternalFailureKind | null;
}

/** Fields carried by the subscription-lifecycle observability events - see
 *  setSubscriptionLifecycleHandler()'s own doc comment. */
export type SubscriptionLifecycleEvent =
  | { kind: 'REJECTED'; symbol: string; tickerId: number; errorCode: number; requestType: 'STREAMING'; retryCount: number; nextRetryAt: number | null; generation: number }
  | { kind: 'RETRY'; symbol: string; previousErrorCode: number | null; retryCount: number; newTickerId: number; generation: number }
  | { kind: 'RECOVERED'; symbol: string; tickerId: number; generation: number }
  /** 2026-09-21 Phase 2: real request-level evidence received - never per-tick, fires once per
   *  transition into ACKNOWLEDGED. */
  | { kind: 'ACKNOWLEDGED'; symbol: string; tickerId: number; acknowledgementKind: 'MARKET_DATA_TYPE' | 'TICK_REQ_PARAMS'; marketDataType: number | null; generation: number }
  /** 2026-09-21 Phase 2: diagnostic only - fires once when a REQUESTING symbol has produced zero
   *  evidence (no tick, no error, no acknowledgement) for marketDataConfirmationTimeoutMs. Never
   *  implies rejection; never changes state. */
  | { kind: 'NO_ACKNOWLEDGEMENT'; symbol: string; tickerId: number; generation: number }
  /** 2026-09-21 Phase 2: a bounded, low-frequency self-healing reissue for a symbol stuck with
   *  zero acknowledgement - distinct from RETRY (which only ever follows a confirmed rejection). */
  | { kind: 'REPROBE'; symbol: string; newTickerId: number; generation: number }
  /** 2026-09-21 Phase 2: account-wide entitlement circuit breaker state transition - see
   *  getAccountEntitlementState()'s own doc comment. */
  | { kind: 'ACCOUNT_ENTITLEMENT_STATE_CHANGED'; state: AccountEntitlementState; canarySymbolsAffected: readonly string[]; generation: number };

/**
 * 2026-09-21 Phase 2: account/session-level entitlement health, inferred ONLY from multiple
 * independent canary (continuousIntelligence.protectedSymbols) symbols receiving the same
 * retryable entitlement error (354/10089) within entitlementDegradedWindowMs - never from one
 * symbol's own error. See markSubscriptionRejected()'s canary-tracking logic and
 * sweepSubscriptionRetries()'s DEGRADED_ENTITLEMENT suppression of ordinary per-symbol retries.
 */
export type AccountEntitlementState = 'NORMAL' | 'DEGRADED_ENTITLEMENT' | 'PROBING' | 'RECOVERED';

export type IbkrSocketConnectionInfo = {
  adapter: 'IB_GATEWAY_SOCKET';
  host: string;
  port: number;
  accountId: string | null;
  serverTime: string | null;
  authenticated: boolean;
  maxMarketDataLines: number;
};

type AccountTags = {
  NetLiquidation?: number;
  AvailableFunds?: number;
  BuyingPower?: number;
  UnrealizedPnL?: number;
  TotalCashValue?: number;
};

type PosRow = {
  symbol: string;
  quantity: number;
  avgCost: number;
  account: string;
};

type TrackedOrder = {
  id: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
  quantity: number;
  filledQuantity: number;
  averageFillPrice: number;
  status: 'PENDING' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELED' | 'REJECTED';
  createdAt: Date;
  updatedAt: Date;
  /**
   * Real crash-recovery fix (2026-09-09, forensic audit finding): previously never set anywhere
   * in this file, so OMS's own client_order_id idempotency contract (real + broker-deduped for
   * Alpaca) silently did nothing for IBKR - a process crash between sending an order and
   * persisting it locally was structurally unrecoverable, not merely degraded. Set from IB's own
   * `orderRef` field (Order.orderRef, a free-text tag IB itself stores and echoes back on every
   * openOrder/orderStatus/execDetails event for that order - not a local-only value). Null for an
   * order placed without one (e.g. a manually-triggered order path that doesn't pass clientOrderId).
   */
  clientOrderId: string | null;
  /**
   * Fill-accounting race fix (2026-09-14 forensic audit pass 3, item 3): orderStatus.filled is IB's
   * own CUMULATIVE running total; execDetails.shares is a PER-EXECUTION increment. IB gives no
   * ordering guarantee between the two event streams for the same real fill, so a naive shared
   * `filledQuantity += shares` on execDetails on top of orderStatus's already-cumulative overwrite
   * double-counts whenever orderStatus lands first (verified: IbkrSocketSession.fillAccounting.test.ts).
   * execDetailsCumulative tracks a running total from the execDetails stream alone; seenExecutionIds
   * (IB's own Execution.execId, genuinely unique per fill) prevents the same execution being summed
   * twice within that stream on a duplicate redelivery. filledQuantity is then always the MAX of
   * both independently-maintained cumulative tracks, never a cross-stream sum.
   */
  execDetailsCumulative: number;
  seenExecutionIds: Set<string>;
};

/** IB's own order-status vocabulary -> Argus's Order.status enum. Shared by the live orderStatus
 *  handler and by openOrder-based rehydration so a rehydrated order's status is derived exactly
 *  the same way a live one already is - no second, possibly-drifting mapping. */
function mapIbkrStatusToTrackedStatus(ibStatus: string, filledQuantity: number, totalQuantity: number): TrackedOrder['status'] {
  const st = String(ibStatus || '').toLowerCase();
  if (st.includes('fill') && filledQuantity + 1e-9 >= totalQuantity && totalQuantity > 0) return 'FILLED';
  if (st.includes('fill') || filledQuantity > 0) return 'PARTIALLY_FILLED';
  if (st.includes('cancel')) return 'CANCELED';
  if (st.includes('inactive') || st.includes('reject')) return 'REJECTED';
  return 'PENDING';
}

export class IbkrSocketSession {
  private ib: IBApi | null = null;
  private cfg: IbkrConnectionConfig;
  private connected = false;
  private nextOrderId = 1;
  private trackedOrders = new Map<number, TrackedOrder>();
  /** clientOrderId (IB orderRef) -> IB orderId. Populated both when Argus itself places an order
   *  and when an order is rehydrated from IB on connect (see connect()'s openOrder handler) - the
   *  crash-recovery fix this whole block exists for depends on the second case specifically. */
  private clientOrderIdIndex = new Map<string, number>();
  private accountId: string | null = null;
  private serverTime: string | null = null;
  private port: number | null = null;
  private accountTags: AccountTags = {};
  private positions = new Map<string, PosRow>();
  private marketDataTicker = 1;
  private activeMktData = new Map<number, string>();
  private symbolToTicker = new Map<string, number>();
  private tickHandler: ((symbol: string, price: number) => void) | null = null;
  /**
   * Real bug found and fixed (2026-09-04 opportunity-capture remediation): `subscribeMarketData()`
   * fires `reqMktData()` and immediately records the symbol as "active" bookkeeping — it never
   * confirmed IB actually granted the line. IB reports a rejected/unsubscribed market-data request
   * (e.g. error 354 "Requested market data is not subscribed", or a missing-permissions message) as
   * an `error` event carrying that request's `reqId` — but the handler below only acted on errors
   * seen before the initial `connect()` promise settled; any error arriving afterward (which is
   * exactly when a per-symbol reqMktData rejection arrives) was silently dropped, with no log, no
   * observability event, nothing. Confirmed live: NVDA/AAPL/MSFT/META/TSLA/AMD/IWM sat in
   * MarketDataWorker's "active" slot list for minutes with tickCount=0 while the ETF/gold anchors
   * (GLD/QQQ/SPY, subscribed long before) kept accumulating ticks normally — the exact shape a
   * silently-rejected reqMktData produces. `recordMarketDataError()`/`marketDataErrorHandler` make
   * that failure visible (never a new kill switch, never a change to what gets subscribed) so an
   * operator — and MissedOpportunityDetector-class tooling — can see *why* a "subscribed" symbol
   * never received real data, instead of it looking like a silent, unexplained data gap.
   */
  private marketDataErrorHandler: ((symbol: string, code: number, message: string) => void) | null = null;
  private marketDataErrors = new Map<string, { code: number; message: string; atMs: number }>();
  /** Desired allocation survives transport loss; request IDs belong to one socket only. */
  private desiredMarketData = new Set<string>();
  /** One latest request handle per desired symbol, retained while disconnected. */
  private desiredRequestHandles = new Map<string, number>();
  private connectionGeneration = 0;
  private marketDataSubscriptionHandler: ((symbol: string) => void) | null = null;
  private nextHistReqId = 50_000;
  /** Serialize historical requests — IB paces hist data; avoid storms. */
  private histChain: Promise<unknown> = Promise.resolve();
  /** Separate ID space from market-data/historical reqIds - see resolveContract(). */
  private nextContractReqId = 900_000;
  /** 2026-09-20 forensic-audit remediation (part B): reqHistoricalData errors previously only
   *  rejected the caller's Promise - invisible to the same IBKR_MARKET_DATA_ERROR observability
   *  path streaming errors use. This is the historical-specific sibling of
   *  marketDataErrorHandler/setMarketDataErrorHandler above. */
  private historicalDataErrorHandler: ((detail: {
    symbol: string; reqId: number; code: number; message: string;
    durationStr: string; barSize: string; whatToShow: string;
  }) => void) | null = null;
  /** 2026-09-20 forensic-audit remediation (part D): IBKR delayed tick fields (66-69) - see
   *  tickPrice handler below. Deliberately separate from tickHandler (the live-quote sink
   *  MarketDataWorker/RiskEngine/OMS ultimately consume) - delayed data must never silently enter
   *  the live trading path. Diagnostics/research only. */
  private delayedTickHandler: ((symbol: string, field: number, price: number) => void) | null = null;
  /** 2026-09-20 remediation: per-symbol subscription lifecycle - see SubscriptionRecord's own doc
   *  comment. Keyed by uppercased symbol; entries are removed on explicit cancel (desire withdrawn)
   *  and left in place across a transport disconnect (matching desiredMarketData's own survival). */
  private subscriptionState = new Map<string, SubscriptionRecord>();
  private subscriptionLifecycleHandler: ((event: SubscriptionLifecycleEvent) => void) | null = null;
  private subscriptionSweepTimer: NodeJS.Timeout | null = null;
  /**
   * 2026-09-21 Phase 2: account-wide entitlement circuit breaker. `canarySymbols` reuses
   * `continuousIntelligence.protectedSymbols` (real, existing config - SPY/QQQ/GLD in this
   * deployment) rather than a new hardcoded list, per the remediation task's own instruction.
   * `canaryErrorTimestamps` tracks only the most recent retryable-error time per canary; a symbol
   * ages out of consideration once its own timestamp falls outside entitlementDegradedWindowMs.
   *
   * Second-pass hardening (2026-09-21): explicit-error evidence alone left a real gap - if IBKR
   * never sends an error at all for the canaries either (total silence, no ack, no tick, no error -
   * a real, plausible account/connectivity failure shape, distinct from but no less real than an
   * explicit 354/10089), the circuit breaker never engaged, and every non-canary symbol kept
   * reprobing independently on its own marketDataUnconfirmedReprobeMs timer forever - the same
   * class of unbounded-request problem the breaker exists to prevent, just triggered by silence
   * instead of an error. Silent evidence is deliberately NOT tracked as a decaying timestamp the
   * way an error is: a reprobe cycle is minutes long (far longer than entitlementDegradedWindowMs),
   * so a fixed-window timestamp would flicker the canary in and out of "degraded" between reprobe
   * attempts even though the underlying silence never actually resolved. Instead,
   * recentDegradedCanaries() reads each canary's CURRENT subscriptionState.lastInternalFailureKind
   * live - it is already exactly "silent right now, yes/no" with no decay needed, and it
   * self-clears the instant real evidence (an ack or a tick) arrives, via the same
   * markSubscriptionAcknowledged()/markSubscriptionRecovered() paths that already reset it.
   */
  private readonly canarySymbols = new Set(continuousIntelligence.protectedSymbols.map((s) => s.toUpperCase()));
  private canaryErrorTimestamps = new Map<string, number>();
  private entitlementState: AccountEntitlementState = 'NORMAL';
  /**
   * Real asymmetry found and fixed (2026-09-06, post-implementation forensic audit): this session
   * had no reconnect-with-backoff of any kind, unlike MarketDataWorker.ts's Alpaca WebSocket path
   * (which already uses this SAME ReconnectBackoff utility). If IB Gateway Desktop was down at
   * boot, or dropped later (closed, forced logout, network hiccup), this connection stayed dead
   * until a full Argus process restart - reproduced live during this pass. connect() itself is
   * cheap to retry when Gateway is down (findFirstOpenTcpPort's own 1500ms probe fails fast, the
   * real IB API handshake is never attempted), so periodic retry costs nothing when there is
   * genuinely nothing listening. Armed only after the first real connect() attempt (never before
   * this adapter is actually asked to connect), and only while the process is running - this never
   * bypasses OMS/RiskEngine and never places an order; it only tries to restore the same
   * connection the adapter already had permission to make.
   */
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectBackoff = new ReconnectBackoff();
  private autoReconnectArmed = false;
  private lastPreferLive = false;
  /**
   * Order-lifecycle crash recovery (2026-09-09 P0 remediation sprint). `trackedOrders`/
   * `clientOrderIdIndex` are in-memory only, so after a process restart they start empty even
   * though IB itself still knows about every open/recent order. This flag distinguishes "rehydration
   * from IB hasn't happened yet on this connection" (unknown - retry later) from "rehydration
   * completed and this order genuinely isn't at the broker" (a real, confirmed answer) - the two
   * must never be conflated, or a live broker order would get marked REJECTED locally by mistake
   * (a false rejection) purely because Argus asked before openOrderEnd arrived. Reset to false at
   * the start of every connect() attempt; set true when IB's openOrderEnd fires for that connection.
   */
  private openOrdersRehydrationComplete = false;

  constructor(cfg?: IbkrConnectionConfig) {
    this.cfg = cfg || loadIbkrConnection();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(reason: string): void {
    if (!this.autoReconnectArmed || this.reconnectTimer) return;
    const delayMs = this.reconnectBackoff.nextDelayMs();
    console.log(`[IBKR Socket] Scheduling reconnect in ${delayMs}ms (${reason})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(this.lastPreferLive);
    }, delayMs);
  }

  /** Stops future auto-reconnect attempts (e.g. this broker is no longer the active selection). Does not tear down an already-open connection. */
  stopAutoReconnect(): void {
    this.autoReconnectArmed = false;
    this.clearReconnectTimer();
  }

  setTickHandler(handler: ((symbol: string, price: number) => void) | null): void {
    this.tickHandler = handler;
  }

  /** Fires whenever IB rejects/errors an *active* market-data reqId (post-connect included). */
  setMarketDataErrorHandler(handler: ((symbol: string, code: number, message: string) => void) | null): void {
    this.marketDataErrorHandler = handler;
  }

  setMarketDataSubscriptionHandler(handler: ((symbol: string) => void) | null): void {
    this.marketDataSubscriptionHandler = handler;
  }

  /** 2026-09-20 remediation (part B): fires for a reqHistoricalData rejection - see
   *  historicalDataErrorHandler's own field doc comment. */
  setHistoricalDataErrorHandler(handler: ((detail: {
    symbol: string; reqId: number; code: number; message: string;
    durationStr: string; barSize: string; whatToShow: string;
  }) => void) | null): void {
    this.historicalDataErrorHandler = handler;
  }

  /** 2026-09-20 remediation (part D): fires for an IBKR delayed tick (field 66-69) - diagnostics
   *  only, NEVER routed to setTickHandler's live sink. See tickPrice handler for field mapping. */
  setDelayedTickHandler(handler: ((symbol: string, field: number, price: number) => void) | null): void {
    this.delayedTickHandler = handler;
  }

  /** 2026-09-20 remediation: fires on a retryable rejection, an actual retry request, and recovery
   *  (real data received again) - never per-tick, never high-cardinality. */
  setSubscriptionLifecycleHandler(handler: ((event: SubscriptionLifecycleEvent) => void) | null): void {
    this.subscriptionLifecycleHandler = handler;
  }

  /** Diagnostics-only snapshot of a symbol's subscription lifecycle record, if tracked. */
  getSubscriptionState(symbol: string): Readonly<SubscriptionRecord> | null {
    return this.subscriptionState.get(symbol.toUpperCase()) ?? null;
  }

  /** 2026-09-21 Phase 2: diagnostics-only snapshot of the account-wide entitlement circuit
   *  breaker. Never mutates anything - pure read of state maintained by markSubscriptionRejected()/
   *  markSubscriptionRecovered(). */
  getAccountEntitlementState(): { state: AccountEntitlementState; canarySymbols: readonly string[]; degradedCanaries: readonly string[] } {
    return { state: this.entitlementState, canarySymbols: [...this.canarySymbols], degradedCanaries: this.recentDegradedCanaries() };
  }

  /** Union of canaries currently showing EITHER a recent explicit retryable error (within
   *  entitlementDegradedWindowMs) OR live, right-now sustained silence (NO_ACKNOWLEDGEMENT) - the
   *  single source of truth both recomputeEntitlementState() and getAccountEntitlementState() read
   *  from, so the two can never disagree. A canary matching both is counted once (Set dedup). */
  private recentDegradedCanaries(): string[] {
    const now = Date.now();
    const errored = [...this.canaryErrorTimestamps.entries()]
      .filter(([, atMs]) => now - atMs < this.cfg.entitlementDegradedWindowMs)
      .map(([sym]) => sym);
    const silent = [...this.canarySymbols].filter(
      (sym) => this.subscriptionState.get(sym)?.lastInternalFailureKind === 'NO_ACKNOWLEDGEMENT',
    );
    return [...new Set([...errored, ...silent])];
  }

  /** Most recent market-data error recorded for `symbol`, if any (cleared on a fresh subscribe). */
  getMarketDataError(symbol: string): { code: number; message: string; atMs: number } | null {
    return this.marketDataErrors.get(symbol.toUpperCase()) ?? null;
  }

  private handleMarketDataError(reqId: number | undefined, code: number, message: string): void {
    if (reqId == null) return;
    const symbol = this.activeMktData.get(reqId);
    if (!symbol) return;
    const record = { code, message, atMs: Date.now() };
    this.marketDataErrors.set(symbol, record);
    try {
      this.marketDataErrorHandler?.(symbol, code, message);
    } catch {
      /* never let a downstream sink break the socket session */
    }
    // 2026-09-20 remediation (part A): IBKR error 200 ("No security definition has been found for
    // the request") is specifically a contract-resolution failure, not an entitlement error - real,
    // confirmed live for BRK.B/SQ. Kick off real IBKR verification in the background so a FUTURE
    // subscribe/order attempt for this symbol can either use the now-qualified contract or refuse
    // cleanly (stockContract()) instead of repeating the same unverified guess forever. Never
    // blocks the current call; never retries the subscription itself; never touches OMS/RiskEngine.
    // Deliberately NOT folded into the retryable-rejection state machine below - a contract-
    // resolution failure and a data-entitlement failure are different problems with different fixes.
    if (code === 200 && this.ib) {
      void this.resolveContract(symbol).catch(() => { /* best-effort background enrichment only */ });
    }
    // 10197 ("competing session") and any other code: unchanged, existing behavior only
    // (marketDataErrors/marketDataErrorHandler above) - never reclassified as an entitlement
    // rejection, never enters the retry state machine below.
    if (this.cfg.marketDataRejectionRetryableCodes.includes(code) && reqId === this.symbolToTicker.get(symbol)) {
      this.markSubscriptionRejected(symbol, reqId, code, message);
    }
  }

  /**
   * 2026-09-20 remediation, core fix: a retryable rejection (354/10089) clears ONLY the local
   * "currently active" belief for this symbol (`activeMktData`/`symbolToTicker` for the rejected
   * reqId) - `desiredMarketData` is never touched here, so the symbol stays fully desired. This is
   * the exact behavior the Sept 18 incident needed: `subscribeMarketData()`'s early-return guard
   * checks `symbolToTicker`, so clearing it here is what lets a later retry actually issue a new
   * `reqMktData()` instead of silently believing the old, rejected request was still good.
   */
  private markSubscriptionRejected(symbol: string, tickerId: number, code: number, message: string): void {
    this.activeMktData.delete(tickerId);
    this.symbolToTicker.delete(symbol);
    const prev = this.subscriptionState.get(symbol);
    const retryCount = (prev?.retryCount ?? 0) + 1;
    const backoffSchedule = this.cfg.marketDataRejectionRetryBackoffMs;
    const delay = backoffSchedule[Math.min(retryCount - 1, backoffSchedule.length - 1)]!;
    const nextRetryAt = Date.now() + delay;
    const next: SubscriptionRecord = {
      symbol,
      tickerId: null,
      // RETRY_WAIT, not REJECTED_RETRYABLE: nextRetryAt is computed synchronously right here, so the
      // symbol is immediately in an active cooldown, not merely "classified as retryable pending a
      // decision." REJECTED_RETRYABLE remains a valid state for a future caller that wants to
      // represent that intermediate moment explicitly.
      state: 'RETRY_WAIT',
      lastRequestAt: prev?.lastRequestAt ?? null,
      lastSuccessAt: prev?.lastSuccessAt ?? null,
      lastErrorAt: Date.now(),
      lastErrorCode: code,
      lastErrorMessage: message,
      retryCount,
      nextRetryAt,
      generation: this.connectionGeneration,
      lastAcknowledgedAt: prev?.lastAcknowledgedAt ?? null,
      acknowledgementKind: prev?.acknowledgementKind ?? null,
      marketDataType: prev?.marketDataType ?? null,
      lastInternalFailureKind: null,
    };
    this.subscriptionState.set(symbol, next);
    this.emitSubscriptionLifecycle({
      kind: 'REJECTED', symbol, tickerId, errorCode: code, requestType: 'STREAMING',
      retryCount, nextRetryAt, generation: this.connectionGeneration,
    });
    // 2026-09-21 Phase 2: account-wide entitlement circuit breaker. Only a retryable code from a
    // CANARY symbol counts as evidence - a non-canary symbol's own rejection never, by itself,
    // implies an account-wide condition (required behavior: "no account-wide circuit breaker" for
    // a single uncommon symbol's own error).
    if (this.cfg.marketDataRejectionRetryableCodes.includes(code) && this.canarySymbols.has(symbol)) {
      this.canaryErrorTimestamps.set(symbol, Date.now());
      this.recomputeEntitlementState();
    }
  }

  /**
   * 2026-09-21 Phase 2: recomputes entitlementState purely from recentDegradedCanaries() (the
   * canaryErrorTimestamps + live-silent-state union) - never mutated from anywhere else, so there
   * is exactly one place this transitions. NORMAL -> DEGRADED_ENTITLEMENT requires
   * `entitlementDegradedCanaryThreshold` DISTINCT canaries with EITHER a recent retryable error OR
   * currently-sustained silence - never one symbol alone.
   */
  private recomputeEntitlementState(): void {
    const recentDegradedCanaries = this.recentDegradedCanaries();
    const prevState = this.entitlementState;
    if (prevState === 'NORMAL' || prevState === 'RECOVERED') {
      if (recentDegradedCanaries.length >= this.cfg.entitlementDegradedCanaryThreshold) {
        this.entitlementState = 'DEGRADED_ENTITLEMENT';
      }
    } else if (prevState === 'DEGRADED_ENTITLEMENT' || prevState === 'PROBING') {
      // A fresh canary error while a probe was outstanding demotes PROBING back to DEGRADED_ENTITLEMENT -
      // real evidence the condition has not actually cleared.
      if (recentDegradedCanaries.length >= this.cfg.entitlementDegradedCanaryThreshold) {
        this.entitlementState = 'DEGRADED_ENTITLEMENT';
      }
    }
    if (this.entitlementState !== prevState) {
      this.emitSubscriptionLifecycle({
        kind: 'ACCOUNT_ENTITLEMENT_STATE_CHANGED', state: this.entitlementState,
        canarySymbolsAffected: recentDegradedCanaries, generation: this.connectionGeneration,
      });
    }
  }

  /**
   * 2026-09-21 Phase 2: canary-driven recovery. Only a canary reaching a real live tick (ACTIVE) -
   * the strongest available evidence - clears the canary's own error timestamp and, if no other
   * canary is still within its error window, advances entitlementState toward RECOVERED and
   * triggers gradual resubscription of symbols the circuit breaker had suppressed. A canary merely
   * being ACKNOWLEDGED (no tick yet) while DEGRADED is weaker evidence and only advances the state
   * to PROBING - required behavior #17's evidence hierarchy ("request acknowledgement... + actual
   * live tick when available" - a tick is the stronger rung, PROBING is the weaker one alone).
   */
  private onCanaryEvidence(symbol: string, strength: 'ACKNOWLEDGED' | 'ACTIVE'): void {
    if (!this.canarySymbols.has(symbol)) return;
    if (strength === 'ACTIVE') {
      this.canaryErrorTimestamps.delete(symbol);
      // No canarySilentTimestamps to clear - silence is read live from subscriptionState, and
      // markSubscriptionRecovered() (the caller here) has already reset lastInternalFailureKind to
      // null for this symbol before this method runs, so recentDegradedCanaries() already reflects
      // the clearance.
      const stillDegraded = this.recentDegradedCanaries().length > 0;
      if ((this.entitlementState === 'DEGRADED_ENTITLEMENT' || this.entitlementState === 'PROBING') && !stillDegraded) {
        this.entitlementState = 'RECOVERED';
        this.emitSubscriptionLifecycle({
          kind: 'ACCOUNT_ENTITLEMENT_STATE_CHANGED', state: 'RECOVERED', canarySymbolsAffected: [], generation: this.connectionGeneration,
        });
        this.beginGradualRecoveryResubscription();
        this.entitlementState = 'NORMAL';
        this.emitSubscriptionLifecycle({
          kind: 'ACCOUNT_ENTITLEMENT_STATE_CHANGED', state: 'NORMAL', canarySymbolsAffected: [], generation: this.connectionGeneration,
        });
      }
    } else if (strength === 'ACKNOWLEDGED' && this.entitlementState === 'DEGRADED_ENTITLEMENT') {
      this.entitlementState = 'PROBING';
      this.emitSubscriptionLifecycle({
        kind: 'ACCOUNT_ENTITLEMENT_STATE_CHANGED', state: 'PROBING', canarySymbolsAffected: [], generation: this.connectionGeneration,
      });
    }
  }

  /**
   * 2026-09-21 Phase 2: once entitlement recovery is confirmed, non-canary symbols the circuit
   * breaker had suppressed (still RETRY_WAIT, past their own nextRetryAt) get resubscribed a
   * bounded few at a time per call - reusing continuousIntelligence.maxNewSubscriptionsPerCycle
   * (an existing, reviewed config value) rather than inventing a new "no thundering herd" number.
   * The sweep's own per-tick cadence naturally staggers the remainder across subsequent ticks.
   */
  private beginGradualRecoveryResubscription(): void {
    const now = Date.now();
    let started = 0;
    const cap = continuousIntelligence.maxNewSubscriptionsPerCycle;
    for (const [sym, record] of this.subscriptionState) {
      if (started >= cap) break;
      if (!this.desiredMarketData.has(sym)) continue;
      if (record.state !== 'RETRY_WAIT' || record.nextRetryAt == null || now < record.nextRetryAt) continue;
      try { this.subscribeMarketData(sym); started++; } catch { /* capacity/connection - try next sweep */ }
    }
  }

  /**
   * 2026-09-20 remediation: proof of success is real data, not a request that merely didn't throw
   * (required behavior #6). Called on every live tick, but only mutates state / emits the RECOVERED
   * event on an actual state TRANSITION into ACTIVE - never logs per-tick (would be exactly the
   * high-cardinality noise this task explicitly says not to produce). Resets retryCount/backoff so
   * a symbol that starts erroring again later gets the full retry schedule from the start, not a
   * stale elevated backoff from a previous, now-irrelevant episode.
   */
  private markSubscriptionRecovered(symbol: string, tickerId: number): void {
    const record = this.subscriptionState.get(symbol);
    const wasActive = record?.state === 'ACTIVE';
    const now = Date.now();
    this.subscriptionState.set(symbol, {
      symbol,
      tickerId,
      state: 'ACTIVE',
      lastRequestAt: record?.lastRequestAt ?? now,
      lastSuccessAt: now,
      lastErrorAt: record?.lastErrorAt ?? null,
      lastErrorCode: record?.lastErrorCode ?? null,
      lastErrorMessage: record?.lastErrorMessage ?? null,
      retryCount: 0,
      nextRetryAt: null,
      generation: this.connectionGeneration,
      lastAcknowledgedAt: record?.lastAcknowledgedAt ?? now,
      acknowledgementKind: record?.acknowledgementKind ?? null,
      marketDataType: record?.marketDataType ?? null,
      lastInternalFailureKind: null,
    });
    if (!wasActive) {
      this.emitSubscriptionLifecycle({ kind: 'RECOVERED', symbol, tickerId, generation: this.connectionGeneration });
    }
    this.onCanaryEvidence(symbol, 'ACTIVE');
  }

  /**
   * 2026-09-21 Phase 2 core fix: real, request-level evidence that IBKR accepted this request -
   * IBKR's own marketDataType ("signals that now API starts to tick with the following market
   * data") and tickReqParams ("returned immediately after a market-data request" for an entitled
   * user) callbacks. Deliberately does NOT mark the subscription ACTIVE or satisfy freshness - only
   * a genuine tick (markSubscriptionRecovered) proves that. Promotes REQUESTING -> ACKNOWLEDGED
   * only; a symbol already ACTIVE or already ACKNOWLEDGED just has its evidence refreshed in place
   * (no downgrade, no duplicate lifecycle event for the same symbol's repeated acks).
   */
  private markSubscriptionAcknowledged(symbol: string, tickerId: number, kind: 'MARKET_DATA_TYPE' | 'TICK_REQ_PARAMS', marketDataType: number | null): void {
    const record = this.subscriptionState.get(symbol);
    if (!record || record.tickerId !== tickerId) return; // stale/superseded ticker - ignore, same guard style as tickPrice
    const now = Date.now();
    const wasUnacknowledged = record.state === 'REQUESTING';
    this.subscriptionState.set(symbol, {
      ...record,
      state: record.state === 'REQUESTING' ? 'ACKNOWLEDGED' : record.state,
      lastAcknowledgedAt: now,
      acknowledgementKind: kind,
      marketDataType: marketDataType ?? record.marketDataType,
      lastInternalFailureKind: null, // real evidence arrived - any prior "no evidence yet" flag is now moot
    });
    if (wasUnacknowledged) {
      this.emitSubscriptionLifecycle({ kind: 'ACKNOWLEDGED', symbol, tickerId, acknowledgementKind: kind, marketDataType, generation: this.connectionGeneration });
    }
    this.onCanaryEvidence(symbol, 'ACKNOWLEDGED');
  }

  private emitSubscriptionLifecycle(event: SubscriptionLifecycleEvent): void {
    try {
      this.subscriptionLifecycleHandler?.(event);
    } catch {
      /* never let a downstream sink break the socket session */
    }
  }

  getConnectionInfo(): IbkrSocketConnectionInfo {
    return {
      adapter: 'IB_GATEWAY_SOCKET',
      host: this.cfg.host,
      port: this.port ?? this.cfg.paperGatewayPort,
      accountId: this.accountId,
      serverTime: this.serverTime,
      authenticated: this.connected && !!this.accountId,
      maxMarketDataLines: this.cfg.maxMarketDataLines,
    };
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(preferLive = false): Promise<boolean> {
    this.lastPreferLive = preferLive;
    this.autoReconnectArmed = true;
    this.clearReconnectTimer(); // an explicit connect() attempt supersedes any pending auto-retry
    this.openOrdersRehydrationComplete = false;
    const disconnected = this.disconnect(true);
    const generation = this.connectionGeneration;
    await disconnected;

    const ports = ibkrSocketPortCandidates(this.cfg, preferLive);
    const openPort = await findFirstOpenTcpPort(this.cfg.host, ports, 1500);
    if (generation !== this.connectionGeneration || !this.autoReconnectArmed) return false;
    if (openPort == null) {
      console.warn(
        `[IBKR Socket] IB Gateway not detected on ${this.cfg.host}:${ports.join('/')}. ` +
          'Launch IB Gateway Desktop in Paper mode (API socket enabled, Read-Only API unchecked).',
      );
      this.scheduleReconnect('Gateway not detected on connect attempt');
      return false;
    }

    const ib = new IBApi({
      host: this.cfg.host,
      port: openPort,
      clientId: this.cfg.clientId,
    });
    this.ib = ib;
    this.port = openPort;

    const timeoutMs = this.cfg.connectTimeoutMs;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };

      const timer = setTimeout(() => {
        if (this.ib !== ib) { finish(false); return; }
        console.warn(`[IBKR Socket] Connect timeout after ${timeoutMs}ms on ${this.cfg.host}:${openPort}`);
        void this.disconnect(true).finally(() => {
          finish(false);
          this.scheduleReconnect('connect timeout');
        });
      }, timeoutMs);

      ib.on(EventName.connected, () => {
        if (this.ib !== ib) return;
        this.connected = true;
        ib.reqIds();
        ib.reqCurrentTime();
        ib.reqManagedAccts();
      });

      ib.on(EventName.disconnected, () => {
        if (this.ib !== ib) return;
        this.connected = false;
        this.activeMktData.clear();
        this.symbolToTicker.clear();
        // Covers a connection that was UP and then dropped (Gateway closed, forced logout, network
        // hiccup) - the finish(false) paths below only cover a connection attempt that never
        // succeeded in the first place. A no-op when this fires as part of an intentional
        // connect()/disconnect() call, since that path already clears/reschedules the timer itself.
        if (settled) this.scheduleReconnect('IB Gateway disconnected');
      });

      ib.on(EventName.error, (err, code, reqId) => {
        if (this.ib !== ib) return;
        if (!settled && code === ErrorCode.CONNECT_FAIL) {
          console.warn(`[IBKR Socket] error code=${code} reqId=${reqId}: ${err?.message || err}`);
          void this.disconnect(true).finally(() => {
            finish(false);
            this.scheduleReconnect('connect failed');
          });
          return;
        }
        if (!settled) {
          console.warn(`[IBKR Socket] warning code=${code} reqId=${reqId}: ${err?.message || err}`);
        }
        // Runs both before and after settle — a per-symbol reqMktData rejection (e.g. "market
        // data is not subscribed") only ever arrives after the connection itself is up, so this
        // must not be gated on `!settled` the way the connect-handshake branches above are.
        this.handleMarketDataError(reqId, Number(code), String(err?.message ?? err ?? ''));
      });

      ib.on(EventName.nextValidId, (orderId: number) => {
        this.nextOrderId = orderId;
      });

      ib.on(EventName.currentTime, (time: number) => {
        this.serverTime = new Date(time * 1000).toISOString();
      });

      ib.on(EventName.managedAccounts, (accountsList: string) => {
        if (this.ib !== ib || !this.connected) return;
        const accounts = String(accountsList || '')
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean);
        const preferred = this.cfg.preferredAccountId;
        const matchPreferred = preferred
          ? accounts.find((a) => a.toUpperCase() === preferred.toUpperCase())
          : undefined;
        this.accountId = matchPreferred || accounts[0] || null;
        if (this.accountId) {
          if (preferred && !matchPreferred) {
            console.warn(
              `[IBKR Socket] preferredAccountId=${preferred} not in managedAccounts=[${accounts.join(',')}]; using ${this.accountId}`,
            );
          }
          this.requestAccountSummary();
          ib.reqPositions();
          // Order-lifecycle crash recovery: rehydrate whatever IB itself still knows about for this
          // account on every successful (re)connect - not just on first boot. Covers the exact
          // dangerous window the 2026-09-09 forensic audit found: Argus sends an order, IB accepts
          // it, Argus crashes/restarts before ever recording that locally. reqOpenOrders() answers
          // via the openOrder/openOrderEnd handlers below; reqExecutions() (no filter = "all
          // recent for this account") separately recovers fills for orders that already fully
          // filled and dropped out of the open-orders set before this reconnect happened - the
          // "crash immediately after a full fill" scenario reqOpenOrders() alone cannot cover.
          try {
            ib.reqOpenOrders();
            ib.reqExecutions(9002, {});
          } catch (e: any) {
            console.error(`[IBKR Socket] order-lifecycle rehydration request failed: ${e?.message || e}`);
          }
          this.reconnectBackoff.reset();
          // IBApi's existing global request scheduler paces these alongside other requests.
          // Deduplication in subscribeMarketData makes repeated managedAccounts events harmless.
          // A stale rejection-cooldown from a prior connection generation is bypassed automatically
          // (subscribeMarketData's cooldown check is generation-scoped) - every desired symbol gets
          // a genuine fresh reqMktData here.
          for (const symbol of this.desiredMarketData) {
            try { this.subscribeMarketData(symbol); }
            catch (e) { console.warn(`[IBKR Socket] Could not restore ${symbol}: ${String(e)}`); }
          }
          // 2026-09-20 remediation: start the bounded-retry sweep once we have a working session.
          this.startSubscriptionSweep();
          finish(true);
        }
      });

      ib.on(EventName.accountSummary, (_reqId, account, tag, value) => {
        if (!this.accountId) this.accountId = account;
        const n = Number(value);
        if (Number.isFinite(n)) {
          (this.accountTags as any)[tag] = n;
        }
      });

      ib.on(EventName.position, (account, contract, pos, avgCost) => {
        const symbol = contract?.symbol || String(contract?.conId || '');
        if (!symbol) return;
        this.positions.set(`${account}:${symbol}`, {
          symbol,
          quantity: pos,
          avgCost: avgCost ?? 0,
          account,
        });
      });

      ib.on(EventName.positionEnd, () => {
        /* snapshot complete */
      });

      ib.on(EventName.orderStatus, (orderId, status, filled, _remaining, avgFillPrice) => {
        const row = this.trackedOrders.get(orderId);
        if (!row) return;
        const filledQty = Number(filled) || 0;
        // Math.max, not a blind overwrite: guards against both a stale/out-of-order orderStatus
        // event regressing a higher value already established, and (see TrackedOrder's own doc
        // comment) cross-stream double-counting against the independently-tracked execDetails sum.
        row.filledQuantity = Math.max(row.filledQuantity, filledQty);
        if (Number(avgFillPrice) > 0) row.averageFillPrice = Number(avgFillPrice);
        row.status = mapIbkrStatusToTrackedStatus(String(status || ''), row.filledQuantity, row.quantity);
        row.updatedAt = new Date();
        // Refresh positions after fills so PortfolioMonitor / recon see IB state promptly.
        if (row.status === 'FILLED' || row.status === 'PARTIALLY_FILLED') {
          try {
            this.ib?.reqPositions();
          } catch { /* ignore */ }
        }
      });

      /**
       * Order-lifecycle crash recovery: IB replies to reqOpenOrders() (called on every successful
       * connect, above) with one openOrder event per order it still has open for this account,
       * terminated by openOrderEnd. This is what makes getTrackedOrderByClientOrderId() actually
       * survive a process restart - without it, trackedOrders/clientOrderIdIndex reset to empty on
       * every boot and a live broker order would look identical to "never sent" to
       * OrderManagement.reconcileStaleOrders(), risking a false REJECTED mark on a real open order.
       * Never overwrites an order this process itself already has fresher in-memory state for
       * (placeStockOrder() already recorded it); only fills in orders this process doesn't yet know
       * about - genuinely rehydrated state, not a guess.
       */
      ib.on(EventName.openOrder, (orderId, contract, order, orderState) => {
        const totalQuantity = Number((order as any)?.totalQuantity) || 0;
        const filledQuantity = Number((order as any)?.filledQuantity) || 0;
        const clientOrderId: string | null = (order as any)?.orderRef || null;
        const existing = this.trackedOrders.get(orderId);
        if (existing) {
          // Already tracked (this process placed it, or a prior openOrder already rehydrated it) -
          // only backfill clientOrderId if this process somehow didn't already have it.
          if (clientOrderId && !existing.clientOrderId) {
            existing.clientOrderId = clientOrderId;
            this.clientOrderIdIndex.set(clientOrderId, orderId);
          }
          return;
        }
        const side: 'BUY' | 'SELL' = String((order as any)?.action || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
        const rehydrated: TrackedOrder = {
          id: orderId,
          symbol: String(contract?.symbol || '').toUpperCase(),
          side,
          type: 'MARKET',
          quantity: totalQuantity,
          filledQuantity,
          averageFillPrice: 0,
          status: mapIbkrStatusToTrackedStatus(String(orderState?.status || ''), filledQuantity, totalQuantity),
          createdAt: new Date(),
          updatedAt: new Date(),
          clientOrderId,
          // Rehydrated from openOrder.filledQuantity, which mirrors orderStatus.filled's cumulative
          // semantics - seed execDetailsCumulative at the same value so a subsequent execDetails for
          // shares already reflected here doesn't get re-added on top (see TrackedOrder's own doc
          // comment on this field).
          execDetailsCumulative: filledQuantity,
          seenExecutionIds: new Set<string>(),
        };
        this.trackedOrders.set(orderId, rehydrated);
        if (clientOrderId) this.clientOrderIdIndex.set(clientOrderId, orderId);
        console.warn(
          `[IBKR Socket] Rehydrated order ${orderId} (${rehydrated.symbol} ${side} x${totalQuantity}, status=${rehydrated.status}` +
            `${clientOrderId ? `, clientOrderId=${clientOrderId}` : ', NO clientOrderId - not placed by (or predates) this crash-recovery mechanism'}` +
            ') on reconnect - was not in this process\'s in-memory order state before this point.',
        );
      });

      ib.on(EventName.openOrderEnd, () => {
        this.openOrdersRehydrationComplete = true;
      });

      ib.on(EventName.execDetails, (_reqId, contract, execution) => {
        const orderId = Number((execution as any)?.orderId);
        if (!Number.isFinite(orderId)) return;
        const shares = Number((execution as any)?.shares) || 0;
        const price = Number((execution as any)?.price) || 0;
        const execClientOrderId: string | null = (execution as any)?.orderRef || null;
        // IB's own genuinely-unique per-execution identifier (Execution.execId) - see
        // TrackedOrder.seenExecutionIds' doc comment for why this exists.
        const execId: string | null = (execution as any)?.execId || null;
        let row = this.trackedOrders.get(orderId);
        if (!row) {
          // Crash-recovery case reqOpenOrders() alone cannot cover: an order that fully filled and
          // dropped out of IB's open-orders set before this process could reconnect. Execution
          // objects carry their own orderRef (Execution.orderRef, same free-text tag as
          // Order.orderRef), so this can still be mapped back to Argus's clientOrderId even with no
          // matching openOrder event. Total quantity is unknown from an execution alone - best
          // honest estimate is "at least this many shares traded", marked FILLED (not
          // PARTIALLY_FILLED) since a fully-dropped-from-open-orders order is the common case this
          // branch exists for; a later, still-arriving execDetails for the same orderId (a real
          // multi-fill order) correctly upgrades filledQuantity below rather than losing it.
          const side: 'BUY' | 'SELL' = String((execution as any)?.side || '').toUpperCase() === 'SLD' ? 'SELL' : 'BUY';
          row = {
            id: orderId,
            symbol: String(contract?.symbol || '').toUpperCase(),
            side,
            type: 'MARKET',
            quantity: shares,
            filledQuantity: 0,
            averageFillPrice: 0,
            status: 'PENDING',
            createdAt: new Date(),
            updatedAt: new Date(),
            clientOrderId: execClientOrderId,
            execDetailsCumulative: 0,
            seenExecutionIds: new Set<string>(),
          };
          this.trackedOrders.set(orderId, row);
          if (execClientOrderId) this.clientOrderIdIndex.set(execClientOrderId, orderId);
          console.warn(
            `[IBKR Socket] Rehydrated order ${orderId} from a bare execution (no openOrder seen)` +
              `${execClientOrderId ? `, clientOrderId=${execClientOrderId}` : ', NO clientOrderId on the execution itself either - cannot map to a local trade row'}.`,
          );
        } else if (execClientOrderId && !row.clientOrderId) {
          row.clientOrderId = execClientOrderId;
          this.clientOrderIdIndex.set(execClientOrderId, orderId);
        }
        // Duplicate redelivery of the same real execution (WS replay / reconnect) - a real broker
        // execution must increase the authoritative fill quantity exactly once regardless of replay.
        // Only skippable when execId is actually present; some IB order types/vintages omit it (a
        // known, honestly-documented residual gap - see DEF-30), in which case this dedup layer
        // can't apply but the cross-stream Math.max reconciliation below still holds.
        if (execId && row.seenExecutionIds.has(execId)) return;
        if (execId) row.seenExecutionIds.add(execId);
        if (shares > 0) {
          const prevExecCum = row.execDetailsCumulative;
          const newExecCum = prevExecCum + shares;
          if (price > 0) {
            row.averageFillPrice =
              prevExecCum > 0
                ? (row.averageFillPrice * prevExecCum + price * shares) / newExecCum
                : price;
          }
          row.execDetailsCumulative = newExecCum;
          // Math.max against orderStatus's own independently-tracked cumulative value - see
          // TrackedOrder.execDetailsCumulative's doc comment. Never a cross-stream sum.
          row.filledQuantity = Math.max(row.filledQuantity, newExecCum);
          row.quantity = Math.max(row.quantity, row.filledQuantity);
          if (row.filledQuantity + 1e-9 >= row.quantity) row.status = 'FILLED';
          else row.status = 'PARTIALLY_FILLED';
          row.updatedAt = new Date();
        }
      });

      ib.on(EventName.tickPrice, (tickerId: number, field: number, price: number) => {
        if (!(price > 0)) return;
        const symbol = this.activeMktData.get(tickerId);
        if (!symbol) return;
        // IB tickType: BID=1, ASK=2, LAST=4 (real-time/live).
        if (field === 4 || field === 1 || field === 2) {
          this.markSubscriptionRecovered(symbol, tickerId);
          this.tickHandler?.(symbol, price);
          return;
        }
        // 2026-09-20 remediation (part D): DELAYED_BID=66, DELAYED_ASK=67, DELAYED_LAST=68,
        // DELAYED_CLOSE=69 - previously silently dropped by the field guard above even when IBKR
        // was actually sending usable delayed data (every observed IBKR_MARKET_DATA_ERROR message
        // in this deployment states "Delayed market data is available"). Routed to a SEPARATE
        // handler, never tickHandler - delayed data must never silently enter the live trading
        // path (MarketDataWorker's live quote cache, RiskEngine, PositionSizing, OMS). See
        // setDelayedTickHandler's own doc comment.
        if (field === 66 || field === 67 || field === 68 || field === 69) {
          this.delayedTickHandler?.(symbol, field, price);
        }
      });

      // 2026-09-21 Phase 2: real IBKR request-level acknowledgement callbacks - confirmed present
      // in the installed @stoqey/ib client (node_modules/@stoqey/ib/dist/api/api.d.ts:1255,2055)
      // with these exact signatures, not assumed from another language's SDK. marketDataType fires
      // "when the user has live-data permission for that instrument" per IBKR's own docs; frozen/
      // delayed/delayed-frozen (2/3/4) are recorded honestly and never treated as live entitlement.
      // Neither callback marks the subscription ACTIVE or satisfies freshness - see
      // markSubscriptionAcknowledged()'s own doc comment.
      ib.on(EventName.marketDataType, (tickerId: number, marketDataType: number) => {
        const symbol = this.activeMktData.get(tickerId);
        if (!symbol) return;
        this.markSubscriptionAcknowledged(symbol, tickerId, 'MARKET_DATA_TYPE', marketDataType);
      });
      ib.on(EventName.tickReqParams, (tickerId: number) => {
        const symbol = this.activeMktData.get(tickerId);
        if (!symbol) return;
        this.markSubscriptionAcknowledged(symbol, tickerId, 'TICK_REQ_PARAMS', null);
      });

      try {
        ib.connect();
      } catch (e: any) {
        console.warn(`[IBKR Socket] connect() threw: ${e?.message || e}`);
        finish(false);
      }
    });
  }

  private requestAccountSummary(): void {
    if (!this.ib || !this.accountId) return;
    try {
      this.ib.reqAccountSummary(
        9001,
        'All',
        'NetLiquidation,AvailableFunds,BuyingPower,UnrealizedPnL,TotalCashValue',
      );
    } catch (e: any) {
      console.warn(`[IBKR Socket] reqAccountSummary failed: ${e?.message || e}`);
    }
  }

  async disconnect(preserveSubscriptions = false): Promise<void> {
    this.connectionGeneration++;
    // 2026-09-20 remediation: the sweep timer belongs to a live session - always stop it here
    // (reconnect's own managedAccounts handler restarts it once a new session is actually up).
    this.stopSubscriptionSweep();
    if (!preserveSubscriptions) {
      this.stopAutoReconnect();
      this.desiredMarketData.clear();
      this.desiredRequestHandles.clear();
      this.subscriptionState.clear();
      // 2026-09-21 Phase 2: entitlement state is preserved across an ordinary transport reconnect
      // (preserveSubscriptions=true) - a dropped socket does not fix an account-side entitlement
      // condition, so resetting it there would silently re-arm ordinary per-symbol retries under
      // real DEGRADED_ENTITLEMENT. Only a full, explicit teardown clears it.
      this.canaryErrorTimestamps.clear();
      this.entitlementState = 'NORMAL';
    }
    const ib = this.ib;
    this.ib = null;
    this.connected = false;
    this.accountId = null;
    this.serverTime = null;
    this.openOrdersRehydrationComplete = false;
    this.activeMktData.clear();
    this.symbolToTicker.clear();
    if (!ib) return;
    try {
      ib.removeAllListeners();
      if (typeof (ib as any).disconnect === 'function') ib.disconnect();
    } catch {
      /* ignore */
    }
  }

  getAccountId(): string | null {
    return this.accountId;
  }

  getAccountTags(): AccountTags {
    return { ...this.accountTags };
  }

  getPositionsSnapshot(): PosRow[] {
    const acct = this.accountId;
    const rows = [...this.positions.values()];
    if (!acct) return rows;
    return rows.filter((p) => !p.account || p.account === acct);
  }

  allocateOrderId(): number {
    const id = this.nextOrderId;
    this.nextOrderId += 1;
    return id;
  }

  /**
   * 2026-09-20 forensic-audit remediation (part A). Consults `ibkrContractResolution.ts`'s cache
   * first: a symbol that has never been through explicit resolution (the overwhelming majority -
   * SMART routing already resolves plain STK contracts correctly for them, confirmed live) gets
   * byte-for-byte the same default contract as before this change - zero behavior change for the
   * working case. A symbol IBKR has already told us it cannot uniquely resolve (AMBIGUOUS /
   * NOT_FOUND from a real `reqContractDetails` call, e.g. the confirmed 200-error cases BRK.B/SQ)
   * throws here instead of silently sending a contract IBKR already rejected - callers must never
   * place an order or subscribe for a different security on a failed resolution.
   */
  stockContract(symbol: string): Contract {
    const sym = symbol.toUpperCase();
    const resolution = getCachedIbkrContractResolution(sym);
    if (resolution?.status === 'RESOLVED') {
      const c = resolution.contract;
      return {
        symbol: c.symbol,
        secType: SecType.STK,
        exchange: c.exchange as any,
        ...(c.primaryExchange ? { primaryExch: c.primaryExchange } : {}),
        currency: c.currency,
        ...(c.conId ? { conId: c.conId } : {}),
      };
    }
    if (resolution?.status === 'AMBIGUOUS' || resolution?.status === 'NOT_FOUND') {
      throw new Error(
        `IBKR contract for ${sym} could not be uniquely resolved (${resolution.status}) - refusing to `
        + `subscribe or place an order under an unverified contract guess.`,
      );
    }
    return {
      symbol: sym,
      secType: SecType.STK,
      exchange: 'SMART',
      currency: 'USD',
    };
  }

  /** Explicit IBKR contract qualification via reqContractDetails - see ibkrContractResolution.ts.
   *  Safe to call repeatedly (cached); callers should treat a non-RESOLVED outcome as this symbol
   *  remaining on the existing default-contract path (or refusing, per stockContract() above) -
   *  this method never mutates trading state and never places an order. */
  async resolveContract(symbol: string): Promise<ContractResolutionOutcome> {
    if (!this.ib) {
      return { status: 'ERROR', symbol: symbol.toUpperCase(), message: 'IBKR socket session is not connected.', resolvedAt: Date.now() };
    }
    return resolveIbkrContract(this.ib, symbol, () => this.allocateContractReqId());
  }

  private allocateContractReqId(): number {
    const id = this.nextContractReqId;
    this.nextContractReqId += 1;
    return id;
  }

  placeStockOrder(opts: {
    symbol: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    type: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
    limitPrice?: number;
    stopPrice?: number;
    account?: string;
    /** Extended-Hours Execution Policy (2026-09-05). Requests IB's real outsideRth order flag -
     *  only honored for a LIMIT order (mission's own "no blind market orders" rule outside RTH,
     *  matching AlpacaBroker's identical LIMIT-only constraint on its own extended_hours flag). */
    extendedHours?: boolean;
    /** Real crash-recovery fix (2026-09-09) - see buildIbkrOrder()'s own doc comment. */
    clientOrderId?: string;
  }): number {
    if (!this.ib || !this.connected) {
      throw new Error('IBKR socket session is not connected. Start IB Gateway Desktop (paper port 4002) and retry.');
    }
    const orderId = this.allocateOrderId();
    const contract = this.stockContract(opts.symbol);
    const order = buildIbkrOrder(orderId, { ...opts, account: opts.account || this.accountId || undefined });

    this.ib.placeOrder(orderId, contract, order);
    this.trackedOrders.set(orderId, {
      id: orderId,
      symbol: opts.symbol.toUpperCase(),
      side: opts.side,
      type: opts.type,
      quantity: opts.quantity,
      filledQuantity: 0,
      averageFillPrice: 0,
      status: 'PENDING',
      createdAt: new Date(),
      updatedAt: new Date(),
      clientOrderId: opts.clientOrderId || null,
      execDetailsCumulative: 0,
      seenExecutionIds: new Set<string>(),
    });
    if (opts.clientOrderId) {
      this.clientOrderIdIndex.set(opts.clientOrderId, orderId);
    }
    return orderId;
  }

  /**
   * Real crash-recovery fix (2026-09-09 forensic audit finding): the one lookup
   * OrderManagement.ts's reconcileStaleOrders() needs and, before this fix, IBKR had no way to
   * ever answer - see IBGatewaySocketAdapter.ts's getOrderByClientOrderId() for the public
   * BrokerAdapter-interface wiring. Works for orders THIS process placed (populated in
   * placeStockOrder() above) and, more importantly for actual crash recovery, for orders
   * rehydrated from IB itself on connect() via reqOpenOrders()/reqExecutions() - see connect()'s
   * openOrder handler.
   */
  getTrackedOrderByClientOrderId(clientOrderId: string): TrackedOrder | undefined {
    const orderId = this.clientOrderIdIndex.get(clientOrderId);
    return orderId != null ? this.trackedOrders.get(orderId) : undefined;
  }

  /**
   * False before IB's openOrderEnd has arrived for the CURRENT connection (rehydration in flight
   * or not yet requested - e.g. never connected, or reconnecting right now). Callers doing
   * crash-recovery lookups (IBGatewaySocketAdapter.getOrderByClientOrderId()) must treat "not found
   * while this is false" as genuinely unknown, not as a confirmed absence - the exact distinction
   * that keeps OrderManagement.reconcileStaleOrders() from marking a real, live IB order REJECTED
   * just because Argus asked before rehydration finished.
   */
  hasCompletedInitialRehydration(): boolean {
    return this.connected && this.openOrdersRehydrationComplete;
  }

  listTrackedOrders(): TrackedOrder[] {
    return [...this.trackedOrders.values()];
  }

  getTrackedOrder(orderId: number): TrackedOrder | undefined {
    return this.trackedOrders.get(orderId);
  }

  cancelOrder(orderId: number): void {
    if (!this.ib || !this.connected) {
      throw new Error('IBKR socket session is not connected.');
    }
    this.ib.cancelOrder(orderId);
  }

  /**
   * Real daily (or mapped) OHLCV via IB Gateway reqHistoricalData.
   * Never fabricates bars — empty / timeout / error throws or returns [].
   */
  requestHistoricalBars(symbol: string, timeframe: string, startMs: number, endMs: number): Promise<Bar[]> {
    const run = () => this.requestHistoricalBarsOnce(symbol, timeframe, startMs, endMs);
    const next = this.histChain.then(run, run);
    this.histChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private requestHistoricalBarsOnce(
    symbol: string,
    timeframe: string,
    startMs: number,
    endMs: number,
  ): Promise<Bar[]> {
    if (!this.ib || !this.connected) {
      return Promise.reject(new Error('IBKR socket session is not connected for historical bars.'));
    }

    const barSize = mapTimeframeToIbBarSize(timeframe);
    if (!barSize) {
      return Promise.reject(
        new Error(`IBKR historical bars: unsupported timeframe ${timeframe} (Quant uses 1Day).`),
      );
    }

    const spanDays = Math.max(1, Math.ceil((endMs - startMs) / 86_400_000));
    const durationStr = spanDays <= 365 ? `${Math.min(365, Math.max(spanDays, 30))} D` : '2 Y';
    const contract = this.stockContract(symbol);
    const reqId = this.nextHistReqId++;
    const ib = this.ib;
    const bars: Bar[] = [];
    const timeoutMs = Math.max(15_000, this.cfg.connectTimeoutMs);

    return new Promise<Bar[]>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ib.removeListener(EventName.historicalData, onBar);
          ib.removeListener(EventName.error, onErr);
        } catch { /* ignore */ }
        fn();
      };

      const timer = setTimeout(() => {
        try { ib.cancelHistoricalData(reqId); } catch { /* ignore */ }
        finish(() => {
          if (bars.length > 0) resolve(bars.filter((b) => b.timestamp >= startMs && b.timestamp <= endMs));
          else reject(new Error(`IBKR historicalData timeout for ${symbol} (${timeframe})`));
        });
      }, timeoutMs);

      const onBar = (
        id: number,
        time: string,
        open: number,
        high: number,
        low: number,
        close: number,
        volume: number,
      ) => {
        if (id !== reqId) return;
        if (!time || String(time).startsWith('finished')) {
          finish(() => resolve(
            bars
              .filter((b) => b.timestamp >= startMs && b.timestamp <= endMs)
              .sort((a, b) => a.timestamp - b.timestamp),
          ));
          return;
        }
        const ts = parseIbBarTime(time);
        if (!Number.isFinite(ts) || !(close > 0)) return;
        bars.push({
          timestamp: ts,
          open: Number(open),
          high: Number(high),
          low: Number(low),
          close: Number(close),
          volume: Number(volume) || 0,
        });
      };

      const onErr = (err: Error, code: ErrorCode, id: number) => {
        if (id !== reqId) return;
        // 2026-09-20 remediation (part B): previously this rejection was the ONLY trace of a
        // historical-data error - invisible to the IBKR_MARKET_DATA_ERROR observability path
        // streaming (reqMktData) errors use, so a caller could not distinguish "streaming
        // entitlement failure" from "historical entitlement/data failure" from persisted evidence
        // alone. Surfaced as its own, clearly-labeled event before rejecting.
        try {
          this.historicalDataErrorHandler?.({
            symbol: symbol.toUpperCase(), reqId, code: Number(code), message: String(err?.message ?? err ?? ''),
            durationStr, barSize: String(barSize), whatToShow: String(WhatToShow.TRADES),
          });
        } catch { /* never let a downstream sink break the socket session */ }
        finish(() => reject(new Error(`IBKR historicalData error code=${code}: ${err?.message || err}`)));
      };

      ib.on(EventName.historicalData, onBar);
      ib.on(EventName.error, onErr);

      try {
        // endDateTime "" = now; formatDate 2 = epoch seconds in `time`
        ib.reqHistoricalData(
          reqId,
          contract,
          '',
          durationStr,
          barSize,
          WhatToShow.TRADES,
          1,
          2,
          false,
        );
      } catch (e: any) {
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    });
  }

  /**
   * Level-1 quotes — sinks via setTickHandler into MarketDataWorker/EventBus when bound.
   *
   * 2026-09-20 remediation: a symbol currently in `RETRY_WAIT`/`REJECTED_RETRYABLE` cooldown is a
   * safe, idempotent no-op here (no new `reqMktData`, no throw) - this is what makes repeated calls
   * from discovery/rescue/rotation cycles during a cooldown harmless (required: "multiple rescue
   * cycles during cooldown -> still exactly zero extra requests"). Once the cooldown has expired,
   * this issues exactly one genuinely new `reqMktData` with a fresh ticker id - the old, rejected
   * ticker id is never reused (already cleared by markSubscriptionRejected()).
   */
  subscribeMarketData(symbol: string): number {
    if (!this.ib || !this.connected) {
      throw new Error('IBKR socket session is not connected.');
    }
    const sym = symbol.toUpperCase();
    const existing = this.symbolToTicker.get(sym);
    if (existing != null) return existing;

    const record = this.subscriptionState.get(sym);
    // Cooldown only applies within the SAME connection generation it was computed under. A real
    // transport disconnect/reconnect (connectionGeneration bumped in disconnect()) is a fresh
    // opportunity independent of an entitlement-rejection backoff calibrated for the old
    // connection - required scenario C ("disconnect before retry -> reconnect -> one valid reissue
    // path only") needs the reissue to actually happen, not wait out a stale cooldown.
    if (record && record.generation === this.connectionGeneration
      && (record.state === 'REJECTED_RETRYABLE' || record.state === 'RETRY_WAIT')
      && record.nextRetryAt != null && Date.now() < record.nextRetryAt) {
      return record.tickerId ?? -1; // cooldown still active - no request sent, nothing to return meaningfully
    }
    // 2026-09-21 Phase 2: capacity is measured against currently-active/requesting broker lines
    // (activeMktData - cleared on rejection), never desiredMarketData (which a rejected-but-still-
    // wanted symbol legitimately keeps occupying forever). This is the real fix for "90 rejected
    // desired symbols permanently block a 91st candidate" - a rejected symbol holds no real IBKR
    // line once markSubscriptionRejected() has cleared activeMktData for it, so it must not count
    // against the cap either. activeMktData.size already excludes REJECTED_RETRYABLE/RETRY_WAIT
    // symbols by construction (both mark* methods delete from it) and already includes
    // REQUESTING/ACKNOWLEDGED/ACTIVE symbols (the only ones actually holding a live IBKR reqId).
    if (this.activeMktData.size >= this.cfg.maxMarketDataLines) {
      throw new Error(`IBKR market-data line cap reached (${this.cfg.maxMarketDataLines}).`);
    }
    const isRetry = !!record && (record.state === 'REJECTED_RETRYABLE' || record.state === 'RETRY_WAIT');
    const tickerId = this.marketDataTicker++;
    this.ib.reqMktData(tickerId, this.stockContract(sym), '', false, false);
    this.marketDataErrors.delete(sym);
    this.desiredRequestHandles.set(sym, tickerId);
    this.desiredMarketData.add(sym);
    this.activeMktData.set(tickerId, sym);
    this.symbolToTicker.set(sym, tickerId);
    const now = Date.now();
    this.subscriptionState.set(sym, {
      symbol: sym,
      tickerId,
      state: 'REQUESTING',
      lastRequestAt: now,
      lastSuccessAt: record?.lastSuccessAt ?? null,
      lastErrorAt: record?.lastErrorAt ?? null,
      lastErrorCode: record?.lastErrorCode ?? null,
      lastErrorMessage: record?.lastErrorMessage ?? null,
      retryCount: record?.retryCount ?? 0,
      nextRetryAt: null,
      generation: this.connectionGeneration,
      lastAcknowledgedAt: null,
      acknowledgementKind: null,
      marketDataType: null,
      lastInternalFailureKind: null,
    });
    if (isRetry) {
      this.emitSubscriptionLifecycle({
        kind: 'RETRY', symbol: sym, previousErrorCode: record!.lastErrorCode,
        retryCount: record!.retryCount, newTickerId: tickerId, generation: this.connectionGeneration,
      });
    }
    try { this.marketDataSubscriptionHandler?.(sym); } catch { /* observer only */ }
    return tickerId;
  }

  /**
   * 2026-09-21 Phase 2 rewrite (post-adversarial-audit of the 2026-09-20 fix). Periodic sweep, one
   * shared timer. Three cases, deliberately kept separate:
   *
   * (1) REQUESTING with zero evidence (no tick, no error, no acknowledgement) for
   *     marketDataConfirmationTimeoutMs: flag NO_ACKNOWLEDGEMENT for diagnostics ONLY - never a
   *     state transition, never a retry-backoff countdown. This is the core correction: the
   *     Sept-20 fix's own confirmation-timeout path treated this exact condition as a rejection
   *     (synthetic errorCode=-1), which produced false RETRY_WAIT transitions on a closed Sunday
   *     market and would do the same for any legitimately-quiet illiquid symbol during real RTH.
   * (2) REQUESTING, already flagged NO_ACKNOWLEDGEMENT, and now past the much longer, much less
   *     aggressive marketDataUnconfirmedReprobeMs: a bounded, low-frequency self-healing reissue
   *     (REPROBE) - the genuine replacement self-healing mechanism for "IBKR never even
   *     acknowledged this," suppressed for non-canary symbols while entitlementState is
   *     DEGRADED_ENTITLEMENT (required behavior: no independent per-symbol retry storm once an
   *     account-wide condition is suspected - only canaries keep probing).
   * (3) RETRY_WAIT / REJECTED_RETRYABLE past nextRetryAt (an EXPLICIT confirmed 354/10089
   *     rejection): unchanged Sept-18 fix behavior for canaries and for every symbol while
   *     entitlementState is NORMAL/RECOVERED/PROBING; suppressed for NON-canary symbols while
   *     DEGRADED_ENTITLEMENT (desired intent preserved, nextRetryAt left untouched so the schedule
   *     resumes exactly where it left off once entitlement recovers - never reset, never advanced).
   */
  private sweepSubscriptionRetries(): void {
    if (!this.ib || !this.connected) return;
    const now = Date.now();
    for (const sym of this.subscriptionState.keys()) {
      if (!this.desiredMarketData.has(sym)) continue; // desire withdrawn - never retry (required behavior D)
      const record = this.subscriptionState.get(sym)!;
      const isCanary = this.canarySymbols.has(sym);
      const suppressedByEntitlement = this.entitlementState === 'DEGRADED_ENTITLEMENT' && !isCanary;

      if (record.state === 'REQUESTING') {
        const sinceRequest = record.lastRequestAt != null ? now - record.lastRequestAt : 0;
        if (record.lastInternalFailureKind === 'NO_ACKNOWLEDGEMENT') {
          // Case (2): already flagged - eligible for the slow reprobe once its own window elapses.
          if (!suppressedByEntitlement && record.lastRequestAt != null && now - record.lastRequestAt >= this.cfg.marketDataUnconfirmedReprobeMs) {
            this.reprobeUnconfirmedSubscription(sym);
          }
          continue;
        }
        // Case (1): first time this request has gone quiet this long - flag it, never reject it.
        if (record.lastRequestAt != null && sinceRequest >= this.cfg.marketDataConfirmationTimeoutMs) {
          const tickerId = record.tickerId;
          this.subscriptionState.set(sym, { ...record, lastInternalFailureKind: 'NO_ACKNOWLEDGEMENT' });
          if (tickerId != null) {
            this.emitSubscriptionLifecycle({ kind: 'NO_ACKNOWLEDGEMENT', symbol: sym, tickerId, generation: this.connectionGeneration });
          }
          // 2026-09-21 second-pass hardening: sustained silence on a CANARY is also real evidence
          // for the account-wide breaker (see the canarySymbols field's own doc comment on why this
          // is read live rather than as a decaying timestamp) - closes the gap where a totally-
          // silent (no error, no ack) account-wide condition never engaged the breaker, leaving
          // every non-canary symbol reprobing independently forever. subscriptionState already
          // reflects the flag (set two lines above) before this recompute reads it.
          if (isCanary) this.recomputeEntitlementState();
        }
        continue;
      }
      // Case (3): unchanged Sept-18 explicit-rejection retry, now entitlement-aware.
      if ((record.state === 'REJECTED_RETRYABLE' || record.state === 'RETRY_WAIT') && record.nextRetryAt != null && now >= record.nextRetryAt) {
        if (suppressedByEntitlement) continue; // desired preserved, nextRetryAt untouched - resumes on recovery
        try { this.subscribeMarketData(sym); } catch (e) { console.warn(`[IBKR Socket] Subscription retry failed for ${sym}: ${String(e)}`); }
      }
    }
  }

  /**
   * 2026-09-21 Phase 2: the bounded, low-frequency self-healing reissue for case (2) above.
   * Deliberately does NOT touch retryCount/nextRetryAt (those remain reserved for the explicit-
   * rejection backoff schedule) and does NOT emit 'RETRY' (reserved for that same schedule) - a
   * distinct 'REPROBE' event keeps the two mechanisms observably separate, matching the adversarial
   * audit's own distinction between "confirmed rejection" and "still unconfirmed."
   */
  private reprobeUnconfirmedSubscription(symbol: string): void {
    if (!this.ib) return;
    const oldTickerId = this.symbolToTicker.get(symbol);
    if (oldTickerId != null) {
      try { this.ib.cancelMktData(oldTickerId); } catch { /* best-effort - IBKR may already consider it gone */ }
      this.activeMktData.delete(oldTickerId);
      this.symbolToTicker.delete(symbol);
    }
    const newTickerId = this.marketDataTicker++;
    this.ib.reqMktData(newTickerId, this.stockContract(symbol), '', false, false);
    this.activeMktData.set(newTickerId, symbol);
    this.symbolToTicker.set(symbol, newTickerId);
    const prev = this.subscriptionState.get(symbol);
    this.subscriptionState.set(symbol, {
      symbol, tickerId: newTickerId, state: 'REQUESTING', lastRequestAt: Date.now(),
      lastSuccessAt: prev?.lastSuccessAt ?? null, lastErrorAt: prev?.lastErrorAt ?? null,
      lastErrorCode: prev?.lastErrorCode ?? null, lastErrorMessage: prev?.lastErrorMessage ?? null,
      retryCount: prev?.retryCount ?? 0, nextRetryAt: prev?.nextRetryAt ?? null, generation: this.connectionGeneration,
      lastAcknowledgedAt: prev?.lastAcknowledgedAt ?? null, acknowledgementKind: prev?.acknowledgementKind ?? null,
      marketDataType: prev?.marketDataType ?? null, lastInternalFailureKind: null,
    });
    this.emitSubscriptionLifecycle({ kind: 'REPROBE', symbol, newTickerId, generation: this.connectionGeneration });
  }

  private startSubscriptionSweep(): void {
    this.stopSubscriptionSweep();
    this.subscriptionSweepTimer = setInterval(() => this.sweepSubscriptionRetries(), this.cfg.marketDataSubscriptionSweepIntervalMs);
    if (typeof this.subscriptionSweepTimer.unref === 'function') this.subscriptionSweepTimer.unref();
  }

  private stopSubscriptionSweep(): void {
    if (this.subscriptionSweepTimer) {
      clearInterval(this.subscriptionSweepTimer);
      this.subscriptionSweepTimer = null;
    }
  }

  cancelMarketData(tickerId: number): void {
    const sym = this.activeMktData.get(tickerId)
      ?? [...this.desiredRequestHandles].find(([, id]) => id === tickerId)?.[0];
    try {
      this.ib?.cancelMktData(tickerId);
    } catch {
      /* ignore */
    }
    this.activeMktData.delete(tickerId);
    if (sym) {
      this.desiredMarketData.delete(sym);
      this.desiredRequestHandles.delete(sym);
      this.symbolToTicker.delete(sym);
      this.marketDataErrors.delete(sym);
      // 2026-09-20 remediation: desire withdrawn -> no retry (required behavior D). The sweep's own
      // `desiredMarketData.has()` guard already makes this safe without this line, but clearing it
      // here avoids an unbounded number of stale entries accumulating for long-rotated-out symbols.
      this.subscriptionState.delete(sym);
    }
  }

  cancelMarketDataBySymbol(symbol: string): void {
    const sym = symbol.toUpperCase();
    this.desiredMarketData.delete(sym);
    this.subscriptionState.delete(sym);
    // 2026-09-20 remediation: a rejected (RETRY_WAIT) symbol has no live ticker mapping to cancel
    // (markSubscriptionRejected already cleared it) - clear the lingering error record directly
    // here too, rather than only as cancelMarketData()'s side effect, so a fully-withdrawn desire
    // never leaves stale error state behind regardless of which lifecycle state it was in.
    this.marketDataErrors.delete(sym);
    const tickerId = this.symbolToTicker.get(sym);
    if (tickerId != null) this.cancelMarketData(tickerId);
    this.desiredRequestHandles.delete(sym);
  }

  activeMarketDataCount(): number {
    return this.activeMktData.size;
  }
}

function mapTimeframeToIbBarSize(timeframe: string): BarSizeSetting | null {
  const t = String(timeframe || '');
  if (t === '1Day' || t === '1D' || t === 'day') return BarSizeSetting.DAYS_ONE;
  if (t === '1Min' || t === '1T') return BarSizeSetting.MINUTES_ONE;
  if (t === '5Min') return BarSizeSetting.MINUTES_FIVE;
  return null;
}

/** IB formatDate=2 → unix seconds string; formatDate=1 → yyyyMMdd or yyyyMMdd HH:mm:ss. */
function parseIbBarTime(time: string): number {
  const raw = String(time || '').trim();
  if (/^\d{9,12}$/.test(raw)) {
    const sec = Number(raw);
    return sec > 1e12 ? sec : sec * 1000;
  }
  // yyyyMMdd
  if (/^\d{8}$/.test(raw)) {
    const y = Number(raw.slice(0, 4));
    const m = Number(raw.slice(4, 6)) - 1;
    const d = Number(raw.slice(6, 8));
    return Date.UTC(y, m, d);
  }
  const parsed = Date.parse(raw.replace(/^(\d{8})\s+/, '$1T'));
  return Number.isFinite(parsed) ? parsed : NaN;
}
