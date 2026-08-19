/**
 * ==========================================================
 * Module:
 * AlpacaBroker.ts
 *
 * Purpose:
 * Core implementation and logic for the AlpacaBroker.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for AlpacaBroker
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

import { BrokerPlugin, BrokerCapabilities, Order, Portfolio, Position } from './BrokerAdapter.js';
import { tradingSafety } from '../server/config/tradingSafety';
import { assertLiveOrdersArmed } from '../server/core/LiveTradingConfirmation';
import { alpacaFetch } from '../server/core/alpacaTls';
import { networkReconnectDelayMs } from '../server/core/reconnectBackoff';
import { networkEndpoints } from '../server/config/networkEndpoints';

// Timeouts/retries live in tradingSafety.json — not TypeScript literals.
const ALPACA_REQUEST_TIMEOUT_MS = tradingSafety.alpacaRequestTimeoutMs;
const ALPACA_MAX_RETRIES = tradingSafety.alpacaMaxRetries;
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = tradingSafety.alpacaCircuitBreakerFailureThreshold;
const CIRCUIT_BREAKER_COOLDOWN_MS = tradingSafety.alpacaCircuitBreakerCooldownMs;

/** Real, typed failure classification - callers (OrderManagement, PortfolioReconciliation, etc.)
 *  can branch on `.kind` instead of parsing an error message string. */
export class AlpacaRequestError extends Error {
  constructor(
    message: string,
    public readonly kind: 'TIMEOUT' | 'NETWORK' | 'RATE_LIMITED' | 'HTTP_ERROR' | 'CIRCUIT_OPEN',
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'AlpacaRequestError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class AlpacaBroker implements BrokerPlugin {
  id = 'alpaca';
  name = 'Alpaca';
  async initialize() { console.log('[AlpacaBroker] Initialized'); }
  async validateCredentials() { return !!this.apiKey; }
  paperTrading() {
    this.isPaper = true;
    this.baseUrl = networkEndpoints.broker.alpaca.paperBaseUrl;
  }
  liveTrading() {
    if (process.env.PAPER_TRADING_ONLY === 'true') {
      throw new Error('Cannot enable LIVE mode when PAPER_TRADING_ONLY is enforced in environment.');
    }
    this.isPaper = false;
    this.baseUrl = networkEndpoints.broker.alpaca.liveBaseUrl;
  }
  getCapabilities(): BrokerCapabilities {
    return {
      canPlaceOrders: true,
      canCancelOrders: true,
      paperTrading: true,
      liveTrading: true,
      usEquities: true,
      canadianEquities: false,
      crypto: false, // this adapter only implements the /v2/* US equities endpoints
      options: false,
      shortSelling: false, // placeOrder doesn't send a short-specific side/flag
      streamingMarketData: false, // real-time ticks come from MarketDataWorker's own WS, not this class
      requiresManualReauth: false, // pure API key/secret auth, no recurring human step
    };
  }
  async health() { return "Healthy"; }
  
  
  private apiKey: string = '';
  private secretKey: string = '';
  private isPaper: boolean = true;
  private baseUrl: string = networkEndpoints.broker.alpaca.paperBaseUrl;

  // Phase 1 circuit-breaker state - per-instance (this class is used as a singleton via
  // BrokerManager in practice, so this really does track "the real Alpaca connection's" health).
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private cachedPortfolio: Portfolio | null = null;

  async connect(credentials: any): Promise<boolean> {
    return this.authenticate(credentials);
  }
  async authenticate(credentials?: any): Promise<boolean> {
    if (credentials?.apiKey || credentials?.secretKey || credentials?.apiSecret) {
      this.apiKey = credentials?.apiKey || process.env.ALPACA_API_KEY || '';
      this.secretKey = credentials?.secretKey || credentials?.apiSecret || process.env.ALPACA_SECRET_KEY || '';
    } else {
      this.apiKey = process.env.ALPACA_API_KEY || '';
      this.secretKey = process.env.ALPACA_SECRET_KEY || '';
    }
    
    // Phase 20: never silently reset LIVE → paper when isLive is omitted.
    // Honor explicit credentials.isLive / tradingMode, else keep paperTrading()/liveTrading().
    const explicitLive = credentials?.isLive;
    const mode = typeof credentials?.tradingMode === 'string' ? credentials.tradingMode.toUpperCase() : '';
    if (explicitLive === true || mode === 'LIVE') {
      if (process.env.PAPER_TRADING_ONLY === 'true') {
        throw new Error('Cannot enable LIVE mode when PAPER_TRADING_ONLY is enforced in environment.');
      }
      this.isPaper = false;
      this.baseUrl = networkEndpoints.broker.alpaca.liveBaseUrl;
    } else if (explicitLive === false || mode === 'PAPER') {
      this.isPaper = true;
      this.baseUrl = networkEndpoints.broker.alpaca.paperBaseUrl;
    }

    if (!this.apiKey || !this.secretKey) return false;
    
    try {
      const res = await this.fetchAlpaca('/v2/account');
      return !!res.id;
    } catch(e) {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    // Nothing to do for REST
  }

  /**
   * Phase 1 (ARGUS_SAFETY_HARDENING_REPORT.md) - the single real choke point for every Alpaca
   * call, now with: a real request timeout (no external call can block the caller indefinitely),
   * a real circuit breaker (fails fast after repeated failures instead of hanging the trading
   * engine on a known-down API), and retry-with-backoff/429 handling - but ONLY for requests
   * explicitly marked `idempotentRetrySafe`. A GET/DELETE is always safe to retry (re-reading or
   * re-cancelling has no duplicate-action risk). A POST (order submission) is ONLY marked safe
   * here when the caller has supplied a real `client_order_id` in the payload - Alpaca itself
   * deduplicates on that field, so retrying a timed-out submission with the same client_order_id
   * cannot create a second real order, even if the first attempt actually reached Alpaca and the
   * response was simply lost. `placeOrder()` below is the only caller that sets this.
   */
  private async fetchAlpaca(path: string, options: RequestInit & { idempotentRetrySafe?: boolean } = {}) {
    const { idempotentRetrySafe = false, ...fetchOptions } = options;

    if (Date.now() < this.circuitOpenUntil) {
      throw new AlpacaRequestError(
        `Alpaca circuit breaker is open (${this.consecutiveFailures} consecutive failures) - failing fast until ${new Date(this.circuitOpenUntil).toISOString()} instead of hammering a known-unhealthy API.`,
        'CIRCUIT_OPEN',
      );
    }

    const maxAttempts = idempotentRetrySafe ? 1 + ALPACA_MAX_RETRIES : 1;
    let lastError: AlpacaRequestError | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        await sleep(networkReconnectDelayMs(attempt - 1));
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), ALPACA_REQUEST_TIMEOUT_MS);
      try {
        const res = await alpacaFetch(`${this.baseUrl}${path}`, {
          ...fetchOptions,
          signal: controller.signal,
          headers: {
            'APCA-API-KEY-ID': this.apiKey,
            'APCA-API-SECRET-KEY': this.secretKey,
            'Content-Type': 'application/json',
            ...fetchOptions.headers,
          },
        });
        clearTimeout(timeoutId);

        if (res.status === 429) {
          const retryAfterHeader = res.headers.get('Retry-After');
          const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
          lastError = new AlpacaRequestError(`Alpaca API rate limited (429) on ${path}`, 'RATE_LIMITED', 429);
          this.recordFailure();
          if (idempotentRetrySafe && attempt < maxAttempts - 1) {
            if (retryAfterMs && Number.isFinite(retryAfterMs)) await sleep(retryAfterMs);
            continue;
          }
          throw lastError;
        }

        if (!res.ok) {
          const err = await res.text();
          this.recordFailure();
          // A definite HTTP error response (4xx/5xx) is a real answer, not an unknown outcome -
          // never blindly retried, even for an idempotent-safe request, since retrying a request
          // Alpaca actively rejected (e.g. insufficient buying power) would just fail the same way.
          throw new AlpacaRequestError(`Alpaca API Error (${res.status}) on ${path}: ${err}`, 'HTTP_ERROR', res.status);
        }

        this.recordSuccess();
        return res.json();
      } catch (e: any) {
        clearTimeout(timeoutId);
        if (e instanceof AlpacaRequestError) {
          if (e.kind === 'HTTP_ERROR') throw e; // already classified and recorded above, never retried
          lastError = e;
        } else if (e?.name === 'AbortError') {
          lastError = new AlpacaRequestError(`Alpaca API request to ${path} timed out after ${ALPACA_REQUEST_TIMEOUT_MS}ms - unknown whether Alpaca received it`, 'TIMEOUT');
          this.recordFailure();
        } else {
          lastError = new AlpacaRequestError(`Alpaca API network error on ${path}: ${e?.message || e}`, 'NETWORK');
          this.recordFailure();
        }
        if (idempotentRetrySafe && attempt < maxAttempts - 1) continue;
        throw lastError;
      }
    }
    // Unreachable in practice (the loop always returns or throws), but keeps TypeScript satisfied.
    throw lastError ?? new AlpacaRequestError(`Alpaca API request to ${path} failed for an unknown reason`, 'NETWORK');
  }

  private recordFailure() {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
      console.error(`[AlpacaBroker] Circuit breaker OPEN after ${this.consecutiveFailures} consecutive failures - failing fast for ${CIRCUIT_BREAKER_COOLDOWN_MS}ms.`);
    }
  }

  private recordSuccess() {
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
  }

  /** Last successful portfolio snapshot retained across transient network outages. */
  getLastKnownPortfolio(): Portfolio | null {
    return this.cachedPortfolio;
  }

  async account(): Promise<any> {
    return this.fetchAlpaca('/v2/account', { idempotentRetrySafe: true });
  }

  async portfolio(): Promise<Portfolio> {
    const account = await this.account();
    const positions = await this.fetchAlpaca('/v2/positions', { idempotentRetrySafe: true });
    
    const mappedPositions = positions.map((p: any) => ({
      symbol: p.symbol,
      quantity: parseFloat(p.qty),
      entryPrice: parseFloat(p.avg_entry_price),
      currentPrice: parseFloat(p.current_price),
      marketValue: parseFloat(p.market_value),
      unrealizedPnl: parseFloat(p.unrealized_pl),
      unrealizedPnlPercent: parseFloat(p.unrealized_plpc),
    }));

    const portfolio: Portfolio = {
      cash: parseFloat(account.cash),
      buyingPower: parseFloat(account.buying_power),
      equity: parseFloat(account.equity),
      positions: mappedPositions,
    };
    this.cachedPortfolio = portfolio;
    return portfolio;
  }

  async getBuyingPower(): Promise<number> {
    const account = await this.account();
    return parseFloat(account.buying_power);
  }

  async orders(): Promise<Order[]> {
    const orders = await this.fetchAlpaca('/v2/orders?status=all', { idempotentRetrySafe: true });
    return orders.map((o: any) => ({
      id: o.id,
      symbol: o.symbol,
      side: o.side.toUpperCase(),
      type: o.order_type.toUpperCase(),
      status: o.status.toUpperCase(),
      quantity: parseFloat(o.qty),
      filledQuantity: parseFloat(o.filled_qty),
      price: o.limit_price ? parseFloat(o.limit_price) : undefined,
      stopPrice: o.stop_price ? parseFloat(o.stop_price) : undefined,
      averageFillPrice: o.filled_avg_price ? parseFloat(o.filled_avg_price) : undefined,
      // Required for OMS inbound reconcile — without this, Argus fills look EXTERNAL_MANUAL.
      clientOrderId: o.client_order_id || undefined,
      createdAt: new Date(o.created_at),
      updatedAt: new Date(o.updated_at)
    }));
  }

  async placeOrder(orderData: Partial<Order>): Promise<Order> {
    // Defense in depth: live Alpaca host refuses unless this process was armed with the
    // confirmation phrase (OMS also checks). Dual flags alone after a restart are not enough.
    if (this.baseUrl.includes('://api.alpaca.markets')) {
      const arm = assertLiveOrdersArmed();
      if (!arm.ok) throw new Error(arm.reason);
    }
    const payload: any = {
      symbol: orderData.symbol,
      qty: orderData.quantity,
      side: orderData.side?.toLowerCase(),
      type: orderData.type?.toLowerCase(),
      time_in_force: 'day'
    };
    if (payload.type === 'limit') payload.limit_price = orderData.price;
    if (payload.type === 'stop') payload.stop_price = orderData.stopPrice;
    // Phase 1 - when the caller supplies a real idempotency key, pass it through as Alpaca's own
    // `client_order_id` and mark this specific POST safe to retry on timeout/network error: Alpaca
    // deduplicates real order submissions on this field, so a retried submission with the SAME key
    // can never create a second real order, even if the first attempt actually reached Alpaca and
    // only the response was lost. Never retried when no key is supplied - that case has no way to
    // know if a bare retry would duplicate a real order.
    let idempotentRetrySafe = false;
    if (orderData.clientOrderId) {
      payload.client_order_id = orderData.clientOrderId;
      idempotentRetrySafe = true;
    }

    const res = await this.fetchAlpaca('/v2/orders', {
      method: 'POST',
      body: JSON.stringify(payload),
      idempotentRetrySafe,
    });
    
    return {
      id: res.id,
      clientOrderId: res.client_order_id || undefined,
      symbol: res.symbol,
      side: res.side.toUpperCase(),
      type: res.order_type.toUpperCase(),
      status: res.status.toUpperCase(),
      quantity: parseFloat(res.qty),
      filledQuantity: parseFloat(res.filled_qty),
      // Real bug found and fixed this pass: a MARKET order (especially on paper) commonly fills
      // synchronously within this same POST response (status "filled", filled_avg_price set) -
      // OMS only re-polls for a fresh price when status is PENDING, so an instant fill's price was
      // silently dropped (fillPrice stayed 0) and persisted into trades.price/fills.price, breaking
      // downstream SELL P&L math. orders()/getOrderByClientOrderId() already mapped this field.
      averageFillPrice: res.filled_avg_price ? parseFloat(res.filled_avg_price) : undefined,
      createdAt: new Date(res.created_at),
      updatedAt: new Date(res.updated_at)
    };
  }

  async modifyOrder(orderId: string, updates: Partial<Order>): Promise<Order> {
    throw new Error('Not implemented');
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    // DELETE is inherently idempotent - cancelling an already-cancelled/filled order just returns
    // a real error with no duplicate side effect, so retrying on timeout/network error is safe.
    await this.fetchAlpaca(`/v2/orders/${orderId}`, { method: 'DELETE', idempotentRetrySafe: true });
    return true;
  }

  async closePosition(symbol: string): Promise<boolean> {
    try {
      await this.fetchAlpaca(`/v2/positions/${symbol}`, { method: 'DELETE', idempotentRetrySafe: true });
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Phase 1, item 3 (order crash recovery) - real lookup by the client-supplied idempotency key,
   * used by OrderManagement's startup/periodic reconciliation to answer "did Alpaca actually
   * receive the order this local row claims to be REJECTED/unrecorded for?" definitively, instead
   * of guessing from local state alone. Returns null (not a thrown error) when Alpaca genuinely
   * has no order under that key - a real, honest "never reached Alpaca" answer.
   */
  async getOrderByClientOrderId(clientOrderId: string): Promise<Order | null> {
    const results = await this.fetchAlpaca(
      `/v2/orders?status=all&client_order_id=${encodeURIComponent(clientOrderId)}`,
      { idempotentRetrySafe: true },
    );
    const match = Array.isArray(results) ? results[0] : results;
    if (!match || !match.id) return null;
    return {
      id: match.id,
      clientOrderId: match.client_order_id || undefined,
      symbol: match.symbol,
      side: match.side.toUpperCase(),
      type: match.order_type.toUpperCase(),
      status: match.status.toUpperCase(),
      quantity: parseFloat(match.qty),
      filledQuantity: parseFloat(match.filled_qty),
      averageFillPrice: match.filled_avg_price ? parseFloat(match.filled_avg_price) : undefined,
      createdAt: new Date(match.created_at),
      updatedAt: new Date(match.updated_at),
    };
  }

  async positions(): Promise<Position[]> {
    const portfolio = await this.portfolio();
    return portfolio.positions;
  }
}
