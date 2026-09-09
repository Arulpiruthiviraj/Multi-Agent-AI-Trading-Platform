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
import { findFirstOpenTcpPort } from './ibkrTcpProbe';
import type { Bar } from '../server/engines/backtest/HistoricalDataGateway';
import { ReconnectBackoff } from '../server/core/reconnectBackoff';

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
  private nextHistReqId = 50_000;
  /** Serialize historical requests — IB paces hist data; avoid storms. */
  private histChain: Promise<unknown> = Promise.resolve();
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
    await this.disconnect();

    const ports = ibkrSocketPortCandidates(this.cfg, preferLive);
    const openPort = await findFirstOpenTcpPort(this.cfg.host, ports, 1500);
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
        console.warn(`[IBKR Socket] Connect timeout after ${timeoutMs}ms on ${this.cfg.host}:${openPort}`);
        void this.disconnect().finally(() => {
          finish(false);
          this.scheduleReconnect('connect timeout');
        });
      }, timeoutMs);

      ib.on(EventName.connected, () => {
        this.connected = true;
        ib.reqIds();
        ib.reqCurrentTime();
        ib.reqManagedAccts();
      });

      ib.on(EventName.disconnected, () => {
        this.connected = false;
        // Covers a connection that was UP and then dropped (Gateway closed, forced logout, network
        // hiccup) - the finish(false) paths below only cover a connection attempt that never
        // succeeded in the first place. A no-op when this fires as part of an intentional
        // connect()/disconnect() call, since that path already clears/reschedules the timer itself.
        if (settled) this.scheduleReconnect('IB Gateway disconnected');
      });

      ib.on(EventName.error, (err, code, reqId) => {
        if (!settled && code === ErrorCode.CONNECT_FAIL) {
          console.warn(`[IBKR Socket] error code=${code} reqId=${reqId}: ${err?.message || err}`);
          void this.disconnect().finally(() => {
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
        row.filledQuantity = filledQty;
        if (Number(avgFillPrice) > 0) row.averageFillPrice = Number(avgFillPrice);
        row.status = mapIbkrStatusToTrackedStatus(String(status || ''), filledQty, row.quantity);
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
        if (shares > 0) {
          const prevFilled = row.filledQuantity;
          const newFilled = prevFilled + shares;
          if (price > 0) {
            row.averageFillPrice =
              prevFilled > 0
                ? (row.averageFillPrice * prevFilled + price * shares) / newFilled
                : price;
          }
          row.filledQuantity = newFilled;
          row.quantity = Math.max(row.quantity, newFilled);
          if (newFilled + 1e-9 >= row.quantity) row.status = 'FILLED';
          else row.status = 'PARTIALLY_FILLED';
          row.updatedAt = new Date();
        }
      });

      ib.on(EventName.tickPrice, (tickerId: number, field: number, price: number) => {
        if (!(price > 0)) return;
        // IB tickType: BID=1, ASK=2, LAST=4
        if (field !== 4 && field !== 1 && field !== 2) return;
        const symbol = this.activeMktData.get(tickerId);
        if (!symbol || !this.tickHandler) return;
        this.tickHandler(symbol, price);
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

  async disconnect(): Promise<void> {
    const ib = this.ib;
    this.ib = null;
    this.connected = false;
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

  stockContract(symbol: string): Contract {
    return {
      symbol: symbol.toUpperCase(),
      secType: SecType.STK,
      exchange: 'SMART',
      currency: 'USD',
    };
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

  /** Level-1 quotes — sinks via setTickHandler into MarketDataWorker/EventBus when bound. */
  subscribeMarketData(symbol: string): number {
    if (!this.ib || !this.connected) {
      throw new Error('IBKR socket session is not connected.');
    }
    const sym = symbol.toUpperCase();
    const existing = this.symbolToTicker.get(sym);
    if (existing != null) return existing;
    if (this.activeMktData.size >= this.cfg.maxMarketDataLines) {
      throw new Error(`IBKR market-data line cap reached (${this.cfg.maxMarketDataLines}).`);
    }
    const tickerId = this.marketDataTicker++;
    this.marketDataErrors.delete(sym);
    this.ib.reqMktData(tickerId, this.stockContract(sym), '', false, false);
    this.activeMktData.set(tickerId, sym);
    this.symbolToTicker.set(sym, tickerId);
    return tickerId;
  }

  cancelMarketData(tickerId: number): void {
    if (!this.ib) return;
    const sym = this.activeMktData.get(tickerId);
    try {
      this.ib.cancelMktData(tickerId);
    } catch {
      /* ignore */
    }
    this.activeMktData.delete(tickerId);
    if (sym) {
      this.symbolToTicker.delete(sym);
      this.marketDataErrors.delete(sym);
    }
  }

  cancelMarketDataBySymbol(symbol: string): void {
    const tickerId = this.symbolToTicker.get(symbol.toUpperCase());
    if (tickerId != null) this.cancelMarketData(tickerId);
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
