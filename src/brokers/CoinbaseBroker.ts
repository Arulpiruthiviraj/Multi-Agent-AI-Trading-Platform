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
      console.error(`[${this.name}] Authentication failed`, e);
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
    const jwt = this.buildJwt(method, path);
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Coinbase API Error (${res.status}): ${errBody}`);
    }
    return res.json();
  }

  async account(): Promise<any> {
    return this.fetchCoinbase('GET', '/api/v3/brokerage/accounts');
  }

  async portfolio(): Promise<Portfolio> {
    const positions = await this.positions();
    // Coinbase spot accounts hold crypto balances directly, not "cash" in the equities-broker
    // sense - available_balance on the account marked default (the primary USD/USDC wallet) is
    // the closest real analogue, found by re-querying accounts here rather than re-deriving it
    // from positions(), which already filters non-zero crypto balances out of the "cash" concept.
    const res = await this.account();
    const fiatAccount = (res?.accounts ?? []).find((a: any) => a.currency === 'USD' || a.currency === 'USDC');
    const cash = fiatAccount ? parseFloat(fiatAccount.available_balance?.value ?? '0') : 0;
    const positionsValue = positions.reduce((sum, p) => sum + p.marketValue, 0);

    return {
      cash,
      buyingPower: cash,
      equity: cash + positionsValue,
      positions,
      unrealizedPnl: positions.reduce((sum, p) => sum + p.unrealizedPnl, 0),
    };
  }

  async getBuyingPower(): Promise<number> {
    return (await this.portfolio()).buyingPower;
  }

  async positions(): Promise<Position[]> {
    const res = await this.account();
    const accounts = (res?.accounts ?? []).filter((a: any) =>
      a.currency !== 'USD' && a.currency !== 'USDC' && parseFloat(a.available_balance?.value ?? '0') > 0
    );

    const positions: Position[] = [];
    for (const acc of accounts) {
      const quantity = parseFloat(acc.available_balance?.value ?? '0');
      const productId = `${acc.currency}-USD`;
      let currentPrice = 0;
      try {
        const product = await this.fetchCoinbase('GET', `/api/v3/brokerage/products/${productId}`);
        currentPrice = parseFloat(product?.price ?? '0');
      } catch (e) {
        // No real USD market for this asset (or a transient error) - skip pricing rather than
        // fabricate a value; the position is still reported with a real quantity, just $0 price.
      }
      positions.push({
        symbol: productId,
        quantity,
        entryPrice: 0, // Coinbase's account balances don't carry a cost basis - not fabricated, genuinely unknown from this endpoint
        currentPrice,
        marketValue: quantity * currentPrice,
        unrealizedPnl: 0, // no entry price to compute this against - see above
        unrealizedPnlPercent: 0,
      });
    }
    return positions;
  }

  async orders(): Promise<Order[]> {
    const res = await this.fetchCoinbase('GET', '/api/v3/brokerage/orders/historical/batch');
    return (res?.orders ?? []).map((o: any) => ({
      id: o.order_id,
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
    if (!order.symbol || !order.side || !order.quantity) {
      throw new Error('placeOrder requires symbol, side, and quantity.');
    }

    const clientOrderId = crypto.randomUUID();
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

    const now = new Date();
    return {
      id: res?.success_response?.order_id ?? clientOrderId,
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
