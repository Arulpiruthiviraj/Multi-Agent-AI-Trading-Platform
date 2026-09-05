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
};

export class IbkrSocketSession {
  private ib: IBApi | null = null;
  private cfg: IbkrConnectionConfig;
  private connected = false;
  private nextOrderId = 1;
  private trackedOrders = new Map<number, TrackedOrder>();
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

  constructor(cfg?: IbkrConnectionConfig) {
    this.cfg = cfg || loadIbkrConnection();
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
    await this.disconnect();

    const ports = ibkrSocketPortCandidates(this.cfg, preferLive);
    const openPort = await findFirstOpenTcpPort(this.cfg.host, ports, 1500);
    if (openPort == null) {
      console.warn(
        `[IBKR Socket] IB Gateway not detected on ${this.cfg.host}:${ports.join('/')}. ` +
          'Launch IB Gateway Desktop in Paper mode (API socket enabled, Read-Only API unchecked).',
      );
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
        void this.disconnect().finally(() => finish(false));
      }, timeoutMs);

      ib.on(EventName.connected, () => {
        this.connected = true;
        ib.reqIds();
        ib.reqCurrentTime();
        ib.reqManagedAccts();
      });

      ib.on(EventName.disconnected, () => {
        this.connected = false;
      });

      ib.on(EventName.error, (err, code, reqId) => {
        if (!settled && code === ErrorCode.CONNECT_FAIL) {
          console.warn(`[IBKR Socket] error code=${code} reqId=${reqId}: ${err?.message || err}`);
          void this.disconnect().finally(() => finish(false));
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
        const st = String(status || '').toLowerCase();
        if (st.includes('fill') && filledQty + 1e-9 >= row.quantity) row.status = 'FILLED';
        else if (st.includes('fill') || filledQty > 0) row.status = 'PARTIALLY_FILLED';
        else if (st.includes('cancel')) row.status = 'CANCELED';
        else if (st.includes('inactive') || st.includes('reject')) row.status = 'REJECTED';
        else row.status = 'PENDING';
        row.updatedAt = new Date();
        // Refresh positions after fills so PortfolioMonitor / recon see IB state promptly.
        if (row.status === 'FILLED' || row.status === 'PARTIALLY_FILLED') {
          try {
            this.ib?.reqPositions();
          } catch { /* ignore */ }
        }
      });

      ib.on(EventName.execDetails, (_reqId, _contract, execution) => {
        const orderId = Number((execution as any)?.orderId);
        if (!Number.isFinite(orderId)) return;
        const row = this.trackedOrders.get(orderId);
        if (!row) return;
        const shares = Number((execution as any)?.shares) || 0;
        const price = Number((execution as any)?.price) || 0;
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
    });
    return orderId;
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
