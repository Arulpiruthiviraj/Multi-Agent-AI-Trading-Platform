/**
 * IB Gateway / TWS TCP socket BrokerPlugin (id: ibkr_gateway).
 * Primary IBKR path — silent auth on 4002/7497, no browser.
 * Orders still only via OMS → BrokerManager.getActiveBroker().placeOrder().
 */
import { BrokerPlugin, BrokerCapabilities, Order, Position, Portfolio } from './BrokerAdapter';
import { assertIbkrSessionAllowsOrder } from './ibkrAccountClassification';
import { loadIbkrConnection, ibkrSocketPortCandidates } from '../server/config/ibkrConnection';
import { IbkrSocketSession } from './IbkrSocketSession';
import { findFirstOpenTcpPort } from './ibkrTcpProbe';

export class IBGatewaySocketAdapter implements BrokerPlugin {
  id = 'ibkr_gateway';
  name = 'IBKR Gateway (Socket)';

  private session: IbkrSocketSession;
  private requestedMode: 'PAPER' | 'LIVE' | null = null;
  private quoteSink: ((symbol: string, price: number) => void) | null = null;

  constructor() {
    this.session = new IbkrSocketSession(loadIbkrConnection());
  }

  /** Used by MarketDataWorker when this adapter is the active quote backend. */
  setQuoteSink(sink: ((symbol: string, price: number) => void) | null): void {
    this.quoteSink = sink;
    this.session.setTickHandler(sink
      ? (symbol, price) => {
          try { this.quoteSink?.(symbol, price); } catch { /* never break socket on sink errors */ }
        }
      : null);
  }

  /**
   * Surfaces a real IB reqMktData rejection (e.g. missing market-data-line permissions) for a
   * symbol MarketDataWorker believes is actively subscribed. Read-only observability wiring —
   * never changes what gets subscribed, never touches OMS/RiskEngine/BrokerManager order paths.
   */
  setMarketDataErrorHandler(handler: ((symbol: string, code: number, message: string) => void) | null): void {
    this.session.setMarketDataErrorHandler(handler);
  }

  getMarketDataError(symbol: string): { code: number; message: string; atMs: number } | null {
    return this.session.getMarketDataError(symbol);
  }

  getConnectionSnapshot(): Record<string, unknown> {
    const info = this.session.getConnectionInfo();
    return {
      ...info,
      mode: 'socket',
      requiresManualReauth: false,
      streamingCapacity: loadIbkrConnection().maxMarketDataLines,
      activeMarketDataLines: this.session.activeMarketDataCount(),
    };
  }

  async initialize(): Promise<void> {
    const cfg = loadIbkrConnection();
    console.log(
      `[${this.name}] Initialized (TCP ${cfg.host}:${cfg.paperGatewayPort}/${cfg.paperTwsPort}, max MD lines=${cfg.maxMarketDataLines})`,
    );
  }

  getCapabilities(): BrokerCapabilities {
    return {
      canPlaceOrders: true,
      canCancelOrders: true,
      paperTrading: true,
      liveTrading: true,
      usEquities: true,
      canadianEquities: false,
      crypto: false,
      options: false,
      shortSelling: false,
      streamingMarketData: true,
      requiresManualReauth: false,
      extendedHoursOrders: true, // placeOrder() sets outsideRth:true for a LIMIT order when Order.extendedHours is set
    };
  }

  async health(): Promise<string> {
    if (this.session.isConnected() && this.session.getAccountId()) return 'Healthy';
    if (this.session.isConnected()) return 'Degraded';
    const cfg = loadIbkrConnection();
    const open = await findFirstOpenTcpPort(
      cfg.host,
      ibkrSocketPortCandidates(cfg, this.requestedMode === 'LIVE'),
      800,
    );
    return open != null ? 'Degraded' : 'Offline';
  }

  async connect(credentials?: any): Promise<boolean> {
    return this.authenticate(credentials);
  }

  async authenticate(_credentials?: any): Promise<boolean> {
    const preferLive = this.requestedMode === 'LIVE' && process.env.PAPER_TRADING_ONLY !== 'true';
    const ok = await this.session.connect(preferLive);
    if (!ok) {
      console.warn(
        `[${this.name}] IB Gateway not detected on port 4002/7497. Launch IB Gateway Desktop in Paper mode ` +
          '(Enable ActiveX and Socket Clients; uncheck Read-Only API). No browser will be opened.',
      );
      return false;
    }
    const info = this.session.getConnectionInfo();
    console.log(
      `[${this.name}] Connected ${info.host}:${info.port} account=${info.accountId || '?'} serverTime=${info.serverTime || '?'}`,
    );
    return true;
  }

  async validateCredentials(): Promise<boolean> {
    return this.session.isConnected() && !!this.session.getAccountId();
  }

  paperTrading(): void {
    this.requestedMode = 'PAPER';
  }

  liveTrading(): void {
    this.requestedMode = 'LIVE';
  }

  async disconnect(): Promise<void> {
    this.setQuoteSink(null);
    await this.session.disconnect();
  }

  async account(): Promise<any> {
    return {
      accountId: this.session.getAccountId(),
      ...this.session.getAccountTags(),
      connection: this.session.getConnectionInfo(),
    };
  }

  async portfolio(): Promise<Portfolio> {
    const tags = this.session.getAccountTags();
    const cash = tags.TotalCashValue ?? tags.AvailableFunds ?? 0;
    const buyingPower = tags.BuyingPower ?? cash;
    const equity = tags.NetLiquidation ?? cash;
    return { cash, buyingPower, equity, positions: await this.positions() };
  }

  async positions(): Promise<Position[]> {
    return this.session.getPositionsSnapshot().map((p) => ({
      symbol: p.symbol,
      quantity: p.quantity,
      entryPrice: p.avgCost,
      currentPrice: p.avgCost,
      marketValue: p.quantity * p.avgCost,
      unrealizedPnl: 0,
      unrealizedPnlPercent: 0,
    }));
  }

  async orders(): Promise<Order[]> {
    return this.session.listTrackedOrders().map((o) => ({
      id: String(o.id),
      // Real bug fix (2026-09-09 P0 remediation sprint): previously omitted here, which broke
      // OrderManagement.reconcileInboundBrokerOrders()'s own dedup check (`o.clientOrderId &&
      // byClientId.has(o.clientOrderId)`) for every IBKR order, including this process's own
      // rehydrated-on-reconnect orders (now populated - see IbkrSocketSession's openOrder/
      // execDetails handlers) - a locally-known order would have been misfiled as an unrecognized
      // SOURCE: EXTERNAL_MANUAL fill instead of reconciled normally.
      clientOrderId: o.clientOrderId || undefined,
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      status: o.status,
      quantity: o.quantity,
      filledQuantity: o.filledQuantity,
      averageFillPrice: o.averageFillPrice > 0 ? o.averageFillPrice : undefined,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
    }));
  }

  async placeOrder(order: Partial<Order>): Promise<Order> {
    if (!order.symbol || !order.side || !order.quantity) {
      throw new Error('placeOrder requires symbol, side, and quantity.');
    }
    if (!this.session.isConnected()) {
      throw new Error('IBKR Gateway socket is not connected. Start IB Gateway Desktop on port 4002 (paper).');
    }
    const accountId = this.session.getAccountId();
    const sessionGate = assertIbkrSessionAllowsOrder({
      requestedMode: this.requestedMode,
      accountId: accountId || '',
    });
    if (!sessionGate.ok) throw new Error(sessionGate.reason);

    const type = (order.type || 'MARKET') as Order['type'];
    if (type !== 'MARKET' && type !== 'LIMIT' && type !== 'STOP' && type !== 'STOP_LIMIT') {
      throw new Error(`IB Gateway socket adapter does not place order type ${type}`);
    }

    const orderId = this.session.placeStockOrder({
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      type,
      limitPrice: order.price,
      stopPrice: order.stopPrice,
      account: accountId || undefined,
      extendedHours: order.extendedHours,
      // Order-lifecycle crash recovery (2026-09-09 P0 remediation sprint): OMS already always
      // passes clientOrderId (the local trades.id UUID) into every placeOrder() call - see
      // OrderManagement.ts executeOrder(). Previously dropped silently here, which is exactly why
      // getOrderByClientOrderId() below had nothing to answer with for IBKR before this fix.
      clientOrderId: order.clientOrderId,
    });

    return {
      id: String(orderId),
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      type,
      status: 'PENDING',
      quantity: order.quantity,
      filledQuantity: 0,
      price: order.price,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  /**
   * Order-lifecycle crash recovery (2026-09-09 P0 remediation sprint) - the IBKR counterpart to
   * AlpacaBroker.getOrderByClientOrderId(). OrderManagement.reconcileStaleOrders() calls this
   * generically whenever a broker implements it; before this method existed, IBKR silently took
   * the "not every broker supports lookup-by-client-order-id" no-op path forever, so a crash
   * between "IB accepted the order" and "Argus recorded it locally" was structurally unrecoverable
   * for IBKR specifically (Alpaca already had it).
   *
   * Deliberately THROWS (not returns null) when this connection's initial order rehydration
   * (reqOpenOrders -> openOrderEnd, triggered on every connect - see IbkrSocketSession.connect())
   * hasn't completed yet, rather than answering "not found". reconcileStaleOrders() treats a thrown
   * lookup as "try again next cycle" (skips the row) - the correct behavior for genuine ambiguity.
   * Returning null here instead would read as a confirmed "IB never received this order" and mark
   * a real, still-open broker order REJECTED purely because Argus asked before rehydration
   * finished - a false rejection, exactly what this whole mechanism exists to prevent.
   */
  async getOrderByClientOrderId(clientOrderId: string): Promise<Order | null> {
    if (!this.session.isConnected()) {
      throw new Error('IBKR Gateway socket is not connected - cannot answer order lookup (ambiguous, not a confirmed absence).');
    }
    if (!this.session.hasCompletedInitialRehydration()) {
      throw new Error('IBKR order rehydration (reqOpenOrders) has not completed yet on this connection - order state is unknown, not confirmed absent.');
    }
    const tracked = this.session.getTrackedOrderByClientOrderId(clientOrderId);
    if (!tracked) return null;
    return {
      id: String(tracked.id),
      clientOrderId: tracked.clientOrderId || undefined,
      symbol: tracked.symbol,
      side: tracked.side,
      type: tracked.type,
      status: tracked.status,
      quantity: tracked.quantity,
      filledQuantity: tracked.filledQuantity,
      averageFillPrice: tracked.averageFillPrice || undefined,
      createdAt: tracked.createdAt,
      updatedAt: tracked.updatedAt,
    };
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    const n = Number(orderId);
    if (!Number.isFinite(n)) return false;
    try {
      this.session.cancelOrder(n);
      return true;
    } catch {
      return false;
    }
  }

  async closePosition(symbol: string): Promise<boolean> {
    const pos = (await this.positions()).find((p) => p.symbol === symbol);
    if (!pos || pos.quantity === 0) return false;
    await this.placeOrder({
      symbol,
      side: pos.quantity > 0 ? 'SELL' : 'BUY',
      type: 'MARKET',
      quantity: Math.abs(pos.quantity),
    });
    return true;
  }

  subscribeMarketData(symbol: string): number {
    return this.session.subscribeMarketData(symbol);
  }

  /** Quant / HistoricalDataGateway — real IB reqHistoricalData bars (never fabricated). */
  async getHistoricalBars(
    symbol: string,
    timeframe: string,
    startMs: number,
    endMs: number,
  ): Promise<Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>> {
    return this.session.requestHistoricalBars(symbol, timeframe, startMs, endMs);
  }

  cancelMarketData(tickerId: number): void {
    this.session.cancelMarketData(tickerId);
  }

  cancelMarketDataBySymbol(symbol: string): void {
    this.session.cancelMarketDataBySymbol(symbol);
  }

  /** Real gateway-socket connectivity for MarketDataWorker's isConnected() (2026-08-25 fix). */
  isMarketDataSessionConnected(): boolean {
    return this.session.isConnected();
  }
}
