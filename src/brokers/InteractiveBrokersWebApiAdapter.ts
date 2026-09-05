/**
 * ==========================================================
 * Module: InteractiveBrokersWebApiAdapter (opt-in Client Portal Web API)
 *
 * Purpose:
 * Real adapter for IBKR's Client Portal (CP) Web API - the current, officially
 * supported retail REST API (confirmed against IBKR's own developer docs,
 * 2026). This is NOT the older TWS socket API, which has no official
 * JavaScript/Node client.
 *
 * Operational model, stated honestly because it materially limits what
 * "canPlaceOrders: true" can mean here:
 *   1. A local "Client Portal Gateway" Java process must be downloaded and
 *      running (https://localhost:5000 by default) - this adapter is an
 *      HTTP client to that local Gateway, not a direct connection to IBKR.
 *      Do NOT confuse this with the TWS/IB Gateway *socket* API on ports
 *      4002 (Gateway paper) / 7497 (TWS paper) — those are unsupported here.
 *   2. A human must open that URL in a browser and complete login + 2FA at
 *      least once per ~24h SSO window. There is no official headless bypass.
 *      Within that window, /tickle keeps the brokerage session alive and
 *      /iserver/auth/ssodh/init can silently restore a lapsed-but-SSO-valid
 *      session without a human - but the initial 2FA login cannot be
 *      automated by this adapter. getCapabilities().requiresManualReauth
 *      is true for exactly this reason.
 *   3. IBKR Canada retail accounts are barred from submitting orders for
 *      Canadian-exchange-listed (TSX/TSXV) equities via any API, per IIROC
 *      Dealer Member Rule 3200A.1(b)(i) - this is a regulatory restriction,
 *      not a technical gap, and cannot be worked around. US-listed symbols
 *      are not subject to this restriction. getCapabilities().canadianEquities
 *      is false for exactly this reason, independent of session state.
 *
 * Endpoints used below (verified against IBKR's CP Web API v1 reference):
 *   GET  /iserver/auth/status
 *   POST /iserver/auth/ssodh/init
 *   POST /tickle
 *   GET  /portfolio/accounts
 *   GET  /portfolio/{accountId}/summary
 *   GET  /portfolio/{accountId}/positions/{pageId}
 *   GET  /iserver/secdef/search?symbol=...
 *   POST /iserver/account/{accountId}/orders
 *   POST /iserver/reply/{replyId}
 *   GET  /iserver/account/order/status/{orderId}
 *   DELETE /iserver/account/{accountId}/order/{orderId}
 * ==========================================================
 */
import https from 'https';
import { BrokerPlugin, BrokerCapabilities, Order, Position, Portfolio } from './BrokerAdapter';
import { networkEndpoints } from '../server/config/networkEndpoints';
import { assertIbkrSessionAllowsOrder } from './ibkrAccountClassification';

interface IBKRRequestOptions {
  method?: string;
  body?: any;
}

export class InteractiveBrokersWebApiAdapter implements BrokerPlugin {
  id = 'ibkr_web';
  name = 'IBKR Web API (Client Portal)';

  // The Client Portal Gateway's self-signed cert is expected and documented by IBKR itself for
  // local development - this agent is scoped to this one adapter's calls to localhost, not a
  // global TLS relaxation.
  private agent = new https.Agent({ rejectUnauthorized: false });
  private baseUrl: string;
  private isAuthenticated = false;
  private tickleInterval: NodeJS.Timeout | null = null;
  private accountId: string | null = null;
  /** Set by paperTrading()/liveTrading() — never inferred from the Gateway session. */
  private requestedMode: 'PAPER' | 'LIVE' | null = null;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.IBKR_GATEWAY_URL || networkEndpoints.broker.ibkr.gatewayUrlDefault;
  }

  async initialize() {
    console.log(`[${this.name}] Initialized (Client Portal Gateway expected at ${this.baseUrl})`);
  }

  private request<T = any>(path: string, options: IBKRRequestOptions = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + path);
      const bodyStr = options.body ? JSON.stringify(options.body) : undefined;
      const req = https.request({
        hostname: url.hostname,
        port: url.port || networkEndpoints.broker.ibkr.gatewayPortDefault,
        path: url.pathname + url.search,
        method: options.method || 'GET',
        agent: this.agent,
        headers: {
          'Content-Type': 'application/json',
          // The Client Portal Gateway's WAF returns a blanket 403 "Access Denied" for any
          // request with no User-Agent - Node's https.request sends none by default (unlike
          // curl/browsers, which is why this can look fine when checked manually with curl).
          'User-Agent': 'OpenAlice-Argus/1.0',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if ((res.statusCode || 500) >= 400) {
            reject(new Error(`IBKR Gateway ${options.method || 'GET'} ${path} -> ${res.statusCode}: ${data.slice(0, 300)}`));
            return;
          }
          try {
            resolve(data ? JSON.parse(data) : (null as any));
          } catch (e) {
            reject(new Error(`IBKR Gateway returned non-JSON for ${path}: ${data.slice(0, 200)}`));
          }
        });
      });
      req.on('error', (e) => reject(new Error(`Cannot reach IBKR Client Portal Gateway at ${this.baseUrl} - is it running? (${e.message})`)));
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  getCapabilities(): BrokerCapabilities {
    return {
      canPlaceOrders: true, // real POST /iserver/account/{accountId}/orders implementation below
      canCancelOrders: true, // real DELETE /iserver/account/{accountId}/order/{orderId} below
      paperTrading: true, // same CP Web API path against a separate paper-account login
      liveTrading: true,
      usEquities: true,
      canadianEquities: false, // regulatory (IIROC 3200A.1(b)(i)), not technical - see module comment
      crypto: false,
      options: false, // not implemented this pass - CP Web API supports it, this adapter doesn't yet
      shortSelling: false, // not implemented this pass
      streamingMarketData: false,
      requiresManualReauth: true, // browser 2FA login required ~every 24h; see module comment
      // placeOrder() does not construct an outsideRth-equivalent order field - the real (accidental)
      // extended-hours completion path this adapter has is via generic IBKR warning auto-confirm,
      // not a deliberate order-construction capability - see the sessionIsolation test's own note.
      extendedHoursOrders: false,
    };
  }

  async health(): Promise<string> {
    try {
      const status = await this.request<{ authenticated: boolean; connected: boolean }>('/iserver/auth/status');
      if (status.authenticated && status.connected) return 'Healthy';
      if (status.connected) return 'Degraded'; // gateway reachable, browser session not authenticated
      return 'Offline';
    } catch (e) {
      return 'Offline';
    }
  }

  async connect(credentials: any): Promise<boolean> { return this.authenticate(credentials); }

  // credentials is intentionally unused - the CP Web API's login flow requires mandatory 2FA
  // through the Gateway's own browser page, which cannot be completed here. This only
  // checks/revives an existing session a human already authenticated via that browser page,
  // exactly as IBKR's own docs describe as the supported pattern.
  async authenticate(credentials?: any): Promise<boolean> {
    try {
      const status = await this.request<{ authenticated: boolean; connected: boolean }>('/iserver/auth/status');
      if (status.authenticated) {
        this.isAuthenticated = true;
      } else if (status.connected) {
        // SSO may still be valid even though the brokerage session lapsed - try to silently
        // restore it before giving up (this part IS real and doesn't need a human).
        try {
          await this.request('/iserver/auth/ssodh/init', { method: 'POST', body: { compete: false, publish: true } });
          const recheck = await this.request<{ authenticated: boolean }>('/iserver/auth/status');
          this.isAuthenticated = !!recheck.authenticated;
        } catch (e) {
          this.isAuthenticated = false;
        }
      } else {
        this.isAuthenticated = false;
      }
    } catch (e) {
      console.warn(`[${this.name}] Not authenticated: no reachable Client Portal Gateway at ${this.baseUrl}. Start it and log in via browser (2FA required) at ${this.baseUrl.replace('/v1/api', '')}.`);
      this.isAuthenticated = false;
    }

    if (this.isAuthenticated && !this.tickleInterval) {
      // Keeps the brokerage session alive - IBKR's own docs specify calling this at least every
      // ~5 minutes; well within that margin here.
      this.tickleInterval = setInterval(() => {
        this.request('/tickle', { method: 'POST' }).catch(() => {});
      }, 60_000);
    }
    return this.isAuthenticated;
  }

  async validateCredentials(): Promise<boolean> { return this.isAuthenticated; }
  // Gateway session paper vs live is which account is logged in at localhost:5000.
  // These methods record Argus's requested mode so placeOrder() can refuse a mismatch.
  paperTrading() { this.requestedMode = 'PAPER'; }
  liveTrading() { this.requestedMode = 'LIVE'; }

  async disconnect(): Promise<void> {
    if (this.tickleInterval) { clearInterval(this.tickleInterval); this.tickleInterval = null; }
    this.isAuthenticated = false;
  }

  private async getAccountId(): Promise<string> {
    if (this.accountId) return this.accountId;
    const accounts = await this.request<{ id: string }[]>('/portfolio/accounts');
    if (!accounts || accounts.length === 0) throw new Error('No IBKR account visible via the Gateway - is the logged-in session authorized for this account?');
    this.accountId = accounts[0].id;
    return this.accountId;
  }

  async account(): Promise<any> {
    const accountId = await this.getAccountId();
    return this.request(`/portfolio/${accountId}/summary`);
  }

  async portfolio(): Promise<Portfolio> {
    const accountId = await this.getAccountId();
    const summary: any = await this.request(`/portfolio/${accountId}/summary`);
    // Field names per CP Web API's account-summary shape: each value is {amount, currency, ...}.
    // Defensive extraction - fall back to 0 rather than throwing if a field is absent, since the
    // exact set of returned fields can vary by account type/permissions.
    const cash = summary?.totalcashvalue?.amount ?? summary?.availablefunds?.amount ?? 0;
    const buyingPower = summary?.buyingpower?.amount ?? cash;
    const equity = summary?.netliquidation?.amount ?? cash;

    const rawPositions: any[] = await this.request(`/portfolio/${accountId}/positions/0`).catch(() => []);
    const positions: Position[] = (rawPositions || []).map((p: any) => ({
      symbol: p.contractDesc || p.ticker || String(p.conid),
      quantity: p.position ?? 0,
      entryPrice: p.avgCost ?? p.avgPrice ?? 0,
      currentPrice: p.mktPrice ?? p.avgCost ?? 0,
      marketValue: p.mktValue ?? 0,
      unrealizedPnl: p.unrealizedPnl ?? 0,
      unrealizedPnlPercent: p.avgCost ? ((p.unrealizedPnl ?? 0) / (Math.abs(p.position ?? 1) * p.avgCost)) : 0,
    }));

    return { cash, buyingPower, equity, positions };
  }

  async positions(): Promise<Position[]> {
    return (await this.portfolio()).positions;
  }

  async getBuyingPower(): Promise<number> {
    return (await this.portfolio()).buyingPower;
  }

  async orders(): Promise<Order[]> {
    const raw: any[] = await this.request('/iserver/account/orders').catch(() => []);
    return (raw || []).map((o: any) => this.mapOrder(o));
  }

  private mapOrder(o: any): Order {
    return {
      id: String(o.orderId ?? o.order_id ?? o.id),
      symbol: o.ticker || o.symbol || '',
      side: (o.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
      type: (o.orderType || 'MARKET').toUpperCase().includes('LMT') ? 'LIMIT' : 'MARKET',
      status: this.mapStatus(o.status),
      quantity: o.totalSize ?? o.quantity ?? 0,
      filledQuantity: o.filledQuantity ?? 0,
      price: o.price,
      averageFillPrice: o.avgPrice,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private mapStatus(ibkrStatus: string): Order['status'] {
    const s = (ibkrStatus || '').toLowerCase();
    if (s.includes('filled')) return 'FILLED';
    if (s.includes('partial')) return 'PARTIALLY_FILLED';
    if (s.includes('cancel')) return 'CANCELED';
    if (s.includes('reject') || s.includes('inactive')) return 'REJECTED';
    return 'PENDING';
  }

  private async resolveConid(symbol: string): Promise<number> {
    const results: any[] = await this.request(`/iserver/secdef/search?symbol=${encodeURIComponent(symbol)}`);
    const match = (results || []).find((r: any) => r.symbol === symbol) || results?.[0];
    if (!match) throw new Error(`Could not resolve a contract id for symbol '${symbol}' via IBKR's secdef search.`);
    return match.conid;
  }

  async placeOrder(order: Partial<Order>): Promise<Order> {
    if (!this.isAuthenticated) {
      throw new Error('IBKR Client Portal Gateway session is not authenticated. A human must log in (with 2FA) at the Gateway URL before orders can be placed.');
    }
    if (!order.symbol || !order.side || !order.quantity) {
      throw new Error('placeOrder requires symbol, side, and quantity.');
    }

    const accountId = await this.getAccountId();
    const sessionGate = assertIbkrSessionAllowsOrder({
      requestedMode: this.requestedMode,
      accountId,
    });
    if (!sessionGate.ok) {
      throw new Error(sessionGate.reason);
    }
    const conid = await this.resolveConid(order.symbol);

    const orderPayload = {
      conid,
      orderType: order.type === 'LIMIT' ? 'LMT' : 'MKT',
      side: order.side,
      quantity: order.quantity,
      price: order.type === 'LIMIT' ? order.price : undefined,
      tif: 'DAY',
    };

    let response: any = await this.request(`/iserver/account/${accountId}/orders`, {
      method: 'POST',
      body: { orders: [orderPayload] },
    });

    // CP Web API frequently returns a confirmation-required message (e.g. price-cap or missing
    // stop-loss warnings) instead of an order id on the first call - must reply to each in turn
    // before the order is actually accepted. This loop is the real documented flow, not a retry hack.
    //
    // Real bug found and fixed this pass: this used to auto-confirm EVERY warning identically,
    // including IBKR's duplicate-order confirmation prompt (the same mechanism it also uses for
    // benign warnings like outside-regular-trading-hours). A retried order submission after a
    // timeout would have its duplicate-order warning silently accepted, risking an unintended
    // double fill. Refuse (rather than guess at IBKR's full message-code taxonomy) specifically
    // when the warning text mentions a duplicate order - every other confirmation type keeps the
    // existing auto-confirm behavior unchanged.
    let guard = 0;
    while (Array.isArray(response) && response[0]?.id && response[0]?.message && guard < 5) {
      const replyId = response[0].id;
      const messageText = Array.isArray(response[0].message) ? response[0].message.join(' ') : String(response[0].message);
      if (/duplicate/i.test(messageText)) {
        throw new Error(`IBKR flagged this as a possible duplicate order and requires manual confirmation - refusing to auto-confirm: ${messageText.slice(0, 300)}`);
      }
      response = await this.request(`/iserver/reply/${replyId}`, { method: 'POST', body: { confirmed: true } });
      guard++;
    }

    const result = Array.isArray(response) ? response[0] : response;
    if (!result || (!result.order_id && !result.orderId)) {
      throw new Error(`IBKR order placement did not return an order id: ${JSON.stringify(result).slice(0, 300)}`);
    }

    return {
      id: String(result.order_id || result.orderId),
      symbol: order.symbol,
      side: order.side,
      type: order.type || 'MARKET',
      status: 'PENDING',
      quantity: order.quantity,
      filledQuantity: 0,
      price: order.price,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  async modifyOrder(orderId: string, updates: Partial<Order>): Promise<Order> {
    throw new Error('Not implemented - CP Web API supports order modification but this adapter does not yet.');
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    const accountId = await this.getAccountId();
    try {
      await this.request(`/iserver/account/${accountId}/order/${orderId}`, { method: 'DELETE' });
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Flatten via a market order of the current position size. There is no dedicated CP
   * "close position" endpoint used here; this reuses placeOrder so RiskEngine/OMS stay the
   * authorization path for live closes that go through Argus rather than a silent flatten.
   * Callers that need a gated exit should still emit a SELL idea. Returns false if no position.
   */
  async closePosition(symbol: string): Promise<boolean> {
    const positions = await this.positions();
    const pos = positions.find(p => p.symbol === symbol);
    if (!pos || pos.quantity === 0) return false;
    const qty = Math.abs(pos.quantity);
    await this.placeOrder({
      symbol,
      side: pos.quantity > 0 ? 'SELL' : 'BUY',
      type: 'MARKET',
      quantity: qty,
    });
    return true;
  }
}
