/**
 * ==========================================================
 * Module: CoinbaseBroker
 *
 * Purpose:
 * Real adapter for Coinbase's current "Advanced Trade" REST API (api.coinbase.com/api/v3/brokerage),
 * authenticated via Coinbase Developer Platform (CDP) API keys - the current key format Coinbase
 * issues (a key name plus an EC private key), which replaced the older HMAC CB-ACCESS-* scheme
 * Coinbase has sunset. Each request is authorized with a short-lived ES256 JWT built from that key,
 * per Coinbase's documented CDP auth scheme - implemented here with Node's built-in `crypto` module
 * (no new dependency needed: ES256 JWT signing is just an EC signature in the JWS "IEEE P1363"
 * raw-R||S format, which `crypto.sign(..., { dsaEncoding: 'ieee-p1363' })` produces directly).
 *
 * Honesty about verification: built directly against Coinbase's published Advanced Trade API
 * reference. Not live-verified against a real Coinbase account or real funds - no test credentials
 * were available while writing this. The JWT construction and request/response mapping logic have
 * unit tests (the parts checkable without a live account); BrokerManager.testConnection() and a
 * genuinely small real order are the way to verify this before trusting it with real money.
 *
 * Unlike every other adapter in this codebase, this one CAN place a real order once authenticated
 * and out of paper mode - Coinbase has no sandbox/paper environment for Advanced Trade, so
 * placeOrder() refuses outright while isPaper is true (the connection's default state) rather than
 * pretending to simulate a fill. Real order placement only becomes possible after the same
 * LIVE_TRADING_CONFIRMATION_PHRASE gate every other broker's live-mode promotion already requires
 * (BrokerManager.setLiveMode()).
 *
 * Order sizing convention: `quantity` is always interpreted as an amount of the BASE asset (e.g.
 * BTC in a BTC-USD order), for both BUY and SELL - Coinbase's own API supports quote-currency
 * (dollar) sizing for market buys too, but base-asset sizing is used uniformly here so callers
 * don't need per-side logic just to size an order.
 *
 * Endpoints used (Advanced Trade API v3):
 *   GET  /api/v3/brokerage/accounts
 *   GET  /api/v3/brokerage/orders/historical/batch
 *   POST /api/v3/brokerage/orders
 *   POST /api/v3/brokerage/orders/batch_cancel
 * ==========================================================
 */
import crypto from 'crypto';
import { BrokerPlugin, BrokerCapabilities, Order, Position, Portfolio } from './BrokerAdapter';
import { networkEndpoints } from '../server/config/networkEndpoints';
import { assertLiveOrdersArmed } from '../server/core/LiveTradingConfirmation';
import { isPaperTradingOnlyEnforced } from '../server/core/tradingModeEnv';
import { logErrorSafely } from '../server/core/SecretRedaction';
import { dataTransportLimits } from '../server/config/dataTransportLimits';

const API_HOST = networkEndpoints.broker.coinbase.apiHost;
const API_BASE = `https://${API_HOST}`;

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class CoinbaseBroker implements BrokerPlugin {
  id = 'coinbase';
  name = 'Coinbase Advanced Trade';

  private keyName: string = '';
  private privateKeyPem: string = '';
  isPaper = true;

  async initialize() { console.log('[' + this.name + '] Initialized'); }
  async validateCredentials() { return !!this.keyName && !!this.privateKeyPem; }
  paperTrading() { this.isPaper = true; }
  liveTrading() { this.isPaper = false; }

  getCapabilities(): BrokerCapabilities {
    return {
      canPlaceOrders: true,
      canCancelOrders: true,
      paperTrading: false, // Coinbase Advanced Trade has no real sandbox/paper environment - see header comment
      liveTrading: true,
      usEquities: false,
      canadianEquities: false,
      crypto: true,
      options: false,
      shortSelling: false, // spot only - this adapter doesn't implement margin/derivatives endpoints
      streamingMarketData: false,
      requiresManualReauth: false, // pure API-key/JWT auth, no recurring human step
      extendedHoursOrders: false, // crypto is 24/7 - the RTH/premarket concept this flag governs doesn't apply
    };
  }

  async health() {
    return (this.keyName && this.privateKeyPem) ? "Healthy" : "Offline";
  }

  async connect(credentials: any): Promise<boolean> {
    return this.authenticate(credentials);
  }

  async authenticate(credentials?: any): Promise<boolean> {
    this.keyName = credentials?.apiKey || process.env.COINBASE_API_KEY || '';
    const rawSecret = credentials?.secretKey || credentials?.apiSecret || process.env.COINBASE_API_SECRET || '';
    // A PEM private key stored in a single-line .env value commonly escapes real newlines as the
    // two characters "\n" - restore them, matching how multi-line PEM env vars are handled
    // elsewhere in this codebase's own conventions for secrets.
    this.privateKeyPem = rawSecret.includes('\\n') ? rawSecret.replace(/\\n/g, '\n') : rawSecret;

    if (!this.keyName || !this.privateKeyPem) return false;

    try {
      await this.fetchCoinbase('GET', '/api/v3/brokerage/accounts');
      return true;
    } catch (e) {
      logErrorSafely(`[${this.name}] Authentication failed`, e);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.keyName = '';
    this.privateKeyPem = '';
  }

  /** Builds Coinbase's CDP-format ES256 JWT for exactly one request (nbf/exp window: 2 minutes). */
  private buildJwt(method: string, path: string): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'ES256', kid: this.keyName, typ: 'JWT', nonce: crypto.randomBytes(16).toString('hex') };
    const payload = { sub: this.keyName, iss: 'cdp', nbf: now, exp: now + 120, uri: `${method} ${API_HOST}${path}` };

    const encodedHeader = base64url(Buffer.from(JSON.stringify(header)));
    const encodedPayload = base64url(Buffer.from(JSON.stringify(payload)));
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    const signature = crypto.sign('sha256', Buffer.from(signingInput), {
      key: this.privateKeyPem,
      dsaEncoding: 'ieee-p1363', // raw R||S, the format JWS ES256 requires - not the DER default
    });

    return `${signingInput}.${base64url(signature)}`;
  }

  private async fetchCoinbase(method: string, path: string, body?: any): Promise<any> {
    const jwt = this.buildJwt(method, path.split('?')[0]);
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(dataTransportLimits.requestTimeoutMs),
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Coinbase API Error (${res.status}): ${errBody}`);
    }
    return res.json();
  }

  async account(): Promise<any> {
    return { accounts: await this.readAllPages('/api/v3/brokerage/accounts', 'accounts'), has_next: false };
  }

  private async readAllPages(path: string, field: 'accounts' | 'orders'): Promise<any[]> {
    const rows: any[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    const deadline = Date.now() + dataTransportLimits.historyTimeoutMs;
    for (let page = 0; page < dataTransportLimits.maxHistoryPages; page++) {
      if (Date.now() >= deadline) throw new Error('Coinbase pagination deadline exceeded; incomplete response');
      const response = await this.fetchCoinbase('GET', cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path);
      if (!Array.isArray(response?.[field]) || typeof response.has_next !== 'boolean') throw new Error('Malformed Coinbase pagination response');
      rows.push(...response[field]);
      if (!response.has_next) return rows;
      if (typeof response.cursor !== 'string' || !response.cursor || cursors.has(response.cursor)) throw new Error('Invalid or repeated Coinbase cursor; incomplete response');
      cursor = response.cursor;
      cursors.add(cursor);
    }
    throw new Error('Coinbase page limit exceeded; incomplete response');
  }

  async portfolio(): Promise<Portfolio> {
    const res = await this.account();
    const positions = await this.positionsFromAccounts(res.accounts);
    // Coinbase spot accounts hold crypto balances directly, not "cash" in the equities-broker
    // sense - available_balance on the account marked default (the primary USD/USDC wallet) is
    // the closest real analogue, found by re-querying accounts here rather than re-deriving it
    // from positions(), which already filters non-zero crypto balances out of the "cash" concept.
    const fiatAccounts = res.accounts.filter((a: any) => a.currency === 'USD' || a.currency === 'USDC');
    const cash = fiatAccounts.reduce((sum: number, a: any) => sum + this.accountQuantity(a), 0);
    const buyingPower = fiatAccounts.reduce((sum: number, a: any) => sum + this.balanceValue(a.available_balance?.value), 0);
    // F26: a position with valuationStatus UNAVAILABLE contributes 0 to these sums rather than a
    // fabricated market value/P&L - this deliberately UNDERSTATES equity/unrealizedPnl instead of
    // inventing a plausible-looking total, and `valuationStatus: 'PARTIAL'` below makes that
    // incompleteness explicit rather than silent, so a caller relying on equity for a complete
    // valuation decision can see it is not one.
    const anyUnavailable = positions.some((p) => p.valuationStatus === 'UNAVAILABLE');
    const positionsValue = positions.reduce((sum, p) => sum + (p.marketValue ?? 0), 0);
    const totalUnrealizedPnl = positions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);

    return {
      cash,
      buyingPower,
      equity: cash + positionsValue,
      positions,
      unrealizedPnl: totalUnrealizedPnl,
      valuationStatus: anyUnavailable ? 'PARTIAL' : 'VALUED',
    };
  }

  async getBuyingPower(): Promise<number> {
    return (await this.portfolio()).buyingPower;
  }

  async positions(): Promise<Position[]> {
    const res = await this.account();
    return this.positionsFromAccounts(res.accounts);
  }

  private balanceValue(value: unknown): number {
    if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') throw new Error('Coinbase balance unavailable');
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Invalid Coinbase balance');
    return parsed;
  }

  private accountQuantity(account: any): number {
    return this.balanceValue(account.available_balance?.value) + this.balanceValue(account.hold?.value);
  }

  private async positionsFromAccounts(allAccounts: any[]): Promise<Position[]> {
    const accounts = allAccounts.filter((a: any) =>
      a.currency !== 'USD' && a.currency !== 'USDC' && this.accountQuantity(a) > 0
    );

    const positions: Position[] = [];
    for (const acc of accounts) {
      const quantity = this.accountQuantity(acc);
      const productId = `${acc.currency}-USD`;
      // F26 (2026-09-27): previously defaulted to 0 and stayed 0 on lookup failure, so a real
      // pricing outage silently reported as a known, valid $0 price/exposure/return instead of an
      // unresolved lookup. `currentPrice` is now null until a real product price is actually
      // parsed; it is never coerced back to 0.
      let currentPrice: number | null = null;
      try {
        const product = await this.fetchCoinbase('GET', `/api/v3/brokerage/products/${productId}`);
        const parsed = parseFloat(product?.price ?? '');
        if (Number.isFinite(parsed) && parsed >= 0) currentPrice = parsed;
      } catch (e) {
        // No real USD market for this asset (or a transient error) - leave currentPrice null
        // rather than fabricate a value; the position is still reported with a real quantity.
      }
      // Coinbase's account-balance endpoint never carries a cost basis at all (not merely on
      // failure) - entryPrice is unconditionally unknown from this endpoint, not just on a
      // pricing-lookup miss. Genuinely null, never a fabricated 0.
      const entryPrice: number | null = null;
      const priceKnown = currentPrice !== null;
      positions.push({
        symbol: productId,
        quantity,
        entryPrice,
        currentPrice,
        // marketValue/unrealizedPnl/unrealizedPnlPercent require a real price (marketValue) or a
        // real price AND a real cost basis (unrealizedPnl*) - both null (never a fabricated 0)
        // whenever either input is unavailable, so a display layer can render "unavailable"
        // instead of a misleading, plausible-looking known zero.
        marketValue: priceKnown ? quantity * currentPrice! : null,
        unrealizedPnl: null, // entryPrice is unconditionally unknown from this endpoint - see above
        unrealizedPnlPercent: null,
        valuationStatus: (priceKnown && entryPrice !== null) ? 'VALUED' : 'UNAVAILABLE',
      });
    }
    return positions;
  }

  async orders(): Promise<Order[]> {
    const rows = await this.readAllPages('/api/v3/brokerage/orders/historical/batch', 'orders');
    return rows.map((o: any) => ({
      id: o.order_id,
      clientOrderId: o.client_order_id,
      symbol: o.product_id,
      side: (o.side ?? '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
      type: mapCoinbaseOrderType(o.order_type),
      status: mapCoinbaseOrderStatus(o.status),
      quantity: parseFloat(o.order_configuration?.market_market_ioc?.base_size ?? o.order_configuration?.limit_limit_gtc?.base_size ?? '0'),
      filledQuantity: parseFloat(o.filled_size ?? '0'),
      price: o.order_configuration?.limit_limit_gtc?.limit_price ? parseFloat(o.order_configuration.limit_limit_gtc.limit_price) : undefined,
      averageFillPrice: o.average_filled_price ? parseFloat(o.average_filled_price) : undefined,
      createdAt: o.created_time ? new Date(o.created_time) : new Date(),
      updatedAt: o.last_fill_time ? new Date(o.last_fill_time) : (o.created_time ? new Date(o.created_time) : new Date()),
    }));
  }

  async placeOrder(order: Partial<Order>): Promise<Order> {
    if (this.isPaper) {
      throw new Error(
        `${this.name} has no real paper/sandbox trading environment - refusing to place a real order while in paper mode. ` +
        `Switch this connection to live mode (with explicit confirmation) to place real orders, or use the Internal Paper Simulator for paper testing.`
      );
    }
    if (isPaperTradingOnlyEnforced()) {
      throw new Error('Cannot place a Coinbase live order when PAPER_TRADING_ONLY is enforced in environment.');
    }
    const arm = assertLiveOrdersArmed();
    if (!arm.ok) throw new Error(arm.reason);
    if (!order.symbol || !['BUY', 'SELL'].includes(order.side ?? '') || !Number.isFinite(order.quantity) || order.quantity! <= 0) {
      throw new Error('placeOrder requires symbol, side, and quantity.');
    }

    if (order.type !== 'MARKET' && order.type !== 'LIMIT') throw new Error('Unsupported Coinbase order type; only MARKET and LIMIT are implemented.');
    if (order.type === 'LIMIT' && (!Number.isFinite(order.price) || order.price! <= 0)) throw new Error('LIMIT requires a finite positive price.');
    if (order.clientOrderId !== undefined && (typeof order.clientOrderId !== 'string' || !order.clientOrderId.trim())) throw new Error('Invalid client order ID.');
    const clientOrderId = order.clientOrderId ?? crypto.randomUUID();
    const baseSize = String(order.quantity);
    const orderConfiguration = order.type === 'LIMIT'
      ? { limit_limit_gtc: { base_size: baseSize, limit_price: String(order.price ?? ''), post_only: false } }
      : { market_market_ioc: { base_size: baseSize } };

    const res = await this.fetchCoinbase('POST', '/api/v3/brokerage/orders', {
      client_order_id: clientOrderId,
      product_id: order.symbol,
      side: order.side,
      order_configuration: orderConfiguration,
    });

    if (res?.success === false) {
      throw new Error(`Coinbase rejected the order: ${res?.error_response?.message || res?.error_response?.error || 'unknown reason'}`);
    }
    if (res?.success !== true || typeof res?.success_response?.order_id !== 'string' || !res.success_response.order_id.trim()) {
      throw new Error('Coinbase order submission outcome unknown: missing broker acknowledgement; reconcile by client order ID before retrying.');
    }

    const now = new Date();
    return {
      id: res.success_response.order_id,
      clientOrderId,
      symbol: order.symbol,
      side: order.side,
      type: order.type === 'LIMIT' ? 'LIMIT' : 'MARKET',
      status: 'PENDING',
      quantity: order.quantity,
      filledQuantity: 0,
      price: order.price,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Order-lifecycle crash recovery (2026-09-22 follow-up pass) - the Coinbase counterpart to
   * IBGatewaySocketAdapter.getOrderByClientOrderId() / AlpacaBroker.getOrderByClientOrderId().
   * OrderManagement.reconcileStaleOrders() calls this generically whenever a broker implements it,
   * to definitively answer "did Coinbase actually receive this order?" for a local row left in a
   * PENDING or possibly-wrongly-REJECTED state, instead of guessing from local state alone. Before
   * this method existed, Coinbase silently took the "not every broker supports lookup-by-client-
   * order-id" no-op path forever - the exact same structural gap DEF-30 closed for IBKR.
   *
   * Unlike IBKR (a stateful streaming socket session with its own in-memory rehydration flag),
   * Coinbase is a stateless REST adapter - there is no separate "has this session synced order
   * state yet" flag to check. The real ambiguity here is authentication/network, not rehydration:
   *  - Not authenticated yet this session (no keyName/privateKeyPem) -> throw (ambiguous: we have
   *    never asked Coinbase anything, so we cannot say the order is absent).
   *  - The historical-orders fetch itself fails (network error, malformed pagination response,
   *    Coinbase API error, pagination deadline/page-limit exceeded) -> throw, exactly as Alpaca's
   *    own fetchAlpaca() call already does implicitly by not catching. Coinbase's Advanced Trade
   *    API has no single "get order by client_order_id" endpoint the way Alpaca's client_order_id
   *    query param does, so this reuses the SAME already-tested readAllPages()/orders() pagination
   *    path used elsewhere in this file rather than adding a second, ad hoc HTTP call - a genuine
   *    Coinbase-side "not found" only becomes knowable once that full, successful listing completes
   *    and the id isn't in it.
   *  - The listing completes successfully and the client_order_id genuinely isn't present -> return
   *    null (confirmed absent), the correct signal for reconcileStaleOrders() to treat this as a
   *    real rejection rather than retry-next-cycle ambiguity.
   */
  async getOrderByClientOrderId(clientOrderId: string): Promise<Order | null> {
    if (!this.keyName || !this.privateKeyPem) {
      throw new Error(`${this.name} is not authenticated - cannot answer order lookup (ambiguous, not a confirmed absence).`);
    }
    const orders = await this.orders();
    const match = orders.find(o => o.clientOrderId === clientOrderId);
    return match ?? null;
  }

  async modifyOrder(orderId: string, updates: Partial<Order>): Promise<Order> {
    throw new Error('Not implemented: Coinbase Advanced Trade orders must be canceled and re-placed rather than modified in place.');
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    const res = await this.fetchCoinbase('POST', '/api/v3/brokerage/orders/batch_cancel', { order_ids: [orderId] });
    const result = res?.results?.[0];
    return !!result?.success;
  }

  /** Flatten by placing a market order of the current base-asset size. Paper mode refuses, same as placeOrder. */
  async closePosition(symbol: string): Promise<boolean> {
    if (this.isPaper) {
      throw new Error(
        `${this.name} has no real paper/sandbox trading environment - refusing to close a real position while in paper mode.`
      );
    }
    const positions = await this.positions();
    const pos = positions.find(p => p.symbol === symbol);
    if (!pos || pos.quantity === 0) return false;
    await this.placeOrder({
      symbol,
      side: pos.quantity > 0 ? 'SELL' : 'BUY',
      type: 'MARKET',
      quantity: Math.abs(pos.quantity),
    });
    return true;
  }
}

function mapCoinbaseOrderType(t: string | undefined): Order['type'] {
  switch ((t ?? '').toUpperCase()) {
    case 'LIMIT': return 'LIMIT';
    case 'STOP': return 'STOP';
    default: return 'MARKET';
  }
}

function mapCoinbaseOrderStatus(s: string | undefined): Order['status'] {
  switch ((s ?? '').toUpperCase()) {
    case 'FILLED': return 'FILLED';
    case 'CANCELLED':
    case 'EXPIRED': return 'CANCELED';
    case 'FAILED': return 'REJECTED';
    case 'OPEN':
    default: return 'PENDING';
  }
}
