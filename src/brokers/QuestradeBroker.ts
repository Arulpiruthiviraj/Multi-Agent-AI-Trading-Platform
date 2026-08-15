/**
 * ==========================================================
 * Module: QuestradeBroker
 *
 * Purpose:
 * Real, read-only adapter for Questrade's official REST API (account/positions/balances/orders).
 *
 * What this adapter can and cannot do, stated honestly:
 *   - Questrade's official developer documentation restricts order-EXECUTION API access to
 *     Questrade-approved partner developers; a third-party retail app (this one) can only ever
 *     get account/market-data access. placeOrder()/modifyOrder() still throw - this is not a
 *     missing feature, it is a real business/API restriction that no amount of code here can
 *     work around. BrokerManager.NON_FUNCTIONAL_BROKER_IDS still refuses to let this become the
 *     active order-placing broker for exactly this reason.
 *   - Everything else - accounts, balances, positions, order HISTORY - is real, public API
 *     surface available to any registered Questrade app, and is now implemented for real instead
 *     of returning hardcoded zeros/empty arrays.
 *   - Built directly against Questrade's published API reference. Not live-verified against a
 *     real Questrade account (no test credentials were available while writing this) - the
 *     request/response shapes below match the documented API; the request-construction and
 *     response-mapping logic has unit tests, but a real account should be used to confirm this
 *     before relying on it (BrokerManager.testConnection() exists for exactly that purpose).
 *
 * OAuth mechanics (the part most likely to trip up a first real use): Questrade's refresh tokens
 * are SINGLE USE - exchanging one for an access token issues a NEW refresh token and invalidates
 * the old one. This adapter persists the newly-issued refresh token back to the `broker_connections`
 * table (encrypted, same as any other saved broker credential) after every successful exchange, so
 * a restart picks up the rotated token automatically via BrokerManager.initialize() - without this,
 * the token configured in QUESTRADE_REFRESH_TOKEN would work exactly once and then permanently fail.
 *
 * Endpoints used (Questrade REST API v1):
 *   GET https://login.questrade.com/oauth2/token?grant_type=refresh_token&refresh_token=...
 *   GET {api_server}v1/accounts
 *   GET {api_server}v1/accounts/{accountNumber}/balances
 *   GET {api_server}v1/accounts/{accountNumber}/positions
 *   GET {api_server}v1/accounts/{accountNumber}/orders
 *   GET {api_server}v1/symbols?names=... (symbolId lookup, cached per instance)
 *   GET {api_server}v1/markets/quotes/{symbolId}
 *   GET {api_server}v1/markets/candles/{symbolId}
 *
 * getQuote()/getHistoricalCandles() below exist for MarketDataCrossChecker (a real second,
 * independent market-data source compared against Alpaca's live feed) - NOT for
 * MarketDataManager's adapter registry, which is a decorative UI-only selector wired to two
 * currently-mocked adapters (Polygon/YahooFinance) and never consulted by the real agent
 * pipeline; registering a second Questrade instance there would also be unsafe, since
 * authenticating it independently would consume/be-consumed-by the same single-use refresh token
 * this instance already rotated. Whether a quote is genuinely real-time depends on the connected
 * account's own market-data package - Questrade's raw response carries isRealTime/delay flags
 * this mapping does not surface, since the shared `Quote` shape has no field for it.
 * ==========================================================
 */
import { BrokerPlugin, BrokerCapabilities, Order, Position, Portfolio } from './BrokerAdapter';
import { Quote, Candle } from '../marketdata/MarketDataAdapter';
import { db } from '../server/db';
import * as schema from '../server/db/schema';
import { eq } from 'drizzle-orm';
import { EncryptionService } from '../server/core/EncryptionService';

// Alpaca-style timeframe strings (the format HistoricalDataGateway already uses) mapped to
// Questrade's own interval enum + approximate bar duration in ms. Unrecognized timeframes fall
// back to '1Day' rather than throwing, since a caller passing a slightly different but
// reasonable string shouldn't hard-fail.
const QUESTRADE_INTERVAL_MAP: Record<string, { interval: string; ms: number }> = {
  '1Min': { interval: 'OneMinute', ms: 60_000 },
  '5Min': { interval: 'FiveMinutes', ms: 5 * 60_000 },
  '15Min': { interval: 'FifteenMinutes', ms: 15 * 60_000 },
  '30Min': { interval: 'HalfHour', ms: 30 * 60_000 },
  '1Hour': { interval: 'OneHour', ms: 60 * 60_000 },
  '1Day': { interval: 'OneDay', ms: 24 * 60 * 60_000 },
  '1Week': { interval: 'OneWeek', ms: 7 * 24 * 60 * 60_000 },
};

interface QuestradeTokenResponse {
  access_token: string;
  api_server: string;
  expires_in: number;
  refresh_token: string;
  token_type: string;
}

export class QuestradeBroker implements BrokerPlugin {
  id = 'questrade';
  name = 'Questrade (Canada)';

  private accessToken: string = '';
  private apiServer: string = '';
  private accountNumber: string | null = null;
  private tokenExpiresAt: number = 0;
  private symbolIdCache: Map<string, number> = new Map();

  async initialize() { console.log('[' + this.name + '] Initialized'); }
  async validateCredentials() { return !!this.accessToken; }
  paperTrading() { /* Questrade has no sandbox/paper environment in the public API - this is always the user's real account, read-only */ }
  liveTrading() { /* no-op: reads are always against the real account regardless of this flag */ }

  getCapabilities(): BrokerCapabilities {
    return {
      canPlaceOrders: false, // partner-only order execution API - a real, permanent restriction, not a gap here
      canCancelOrders: false,
      paperTrading: false,
      liveTrading: false,
      usEquities: false,
      canadianEquities: false, // no order-placement capability of any kind, so this stays false even though the account itself is Canadian
      crypto: false,
      options: false,
      shortSelling: false,
      streamingMarketData: false,
      requiresManualReauth: false, // refresh-token OAuth renews itself; no recurring human step
    };
  }
  async health() {
    return this.accessToken ? "Healthy" : "Offline";
  }

  isPaper = false;

  async connect(credentials: any): Promise<boolean> {
    return this.authenticate(credentials);
  }

  /**
   * credentials.apiKey (or QUESTRADE_REFRESH_TOKEN) carries the refresh token; credentials.secretKey
   * (or QUESTRADE_ACCOUNT_ID) optionally pins a specific account number - if omitted, the first
   * account returned by /v1/accounts is used automatically.
   */
  async authenticate(credentials?: any): Promise<boolean> {
    const refreshToken = credentials?.apiKey || process.env.QUESTRADE_REFRESH_TOKEN || '';
    this.accountNumber = credentials?.secretKey || process.env.QUESTRADE_ACCOUNT_ID || null;

    if (!refreshToken) return false;

    try {
      const tokenRes = await fetch(
        `https://login.questrade.com/oauth2/token?grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
      );
      if (!tokenRes.ok) {
        console.error(`[${this.name}] Token refresh failed: HTTP ${tokenRes.status}`);
        return false;
      }
      const token: QuestradeTokenResponse = await tokenRes.json();
      this.accessToken = token.access_token;
      this.apiServer = token.api_server.endsWith('/') ? token.api_server : token.api_server + '/';
      this.tokenExpiresAt = Date.now() + token.expires_in * 1000;

      // Real, single-use rotation: persist the NEW refresh token now, before it's needed again.
      await this.persistRotatedRefreshToken(token.refresh_token);

      if (!this.accountNumber) {
        const accounts = await this.fetchQuestrade('v1/accounts');
        this.accountNumber = accounts?.accounts?.[0]?.number ?? null;
      }

      return true;
    } catch (e) {
      console.error(`[${this.name}] Authentication failed`, e);
      return false;
    }
  }

  private async persistRotatedRefreshToken(newRefreshToken: string): Promise<void> {
    try {
      const encrypted = EncryptionService.encrypt(newRefreshToken);
      const existing = await db.select().from(schema.brokerConnections).where(eq(schema.brokerConnections.brokerName, this.name));
      if (existing.length > 0) {
        await db.update(schema.brokerConnections).set({ apiKeyEncrypted: encrypted }).where(eq(schema.brokerConnections.brokerName, this.name));
      } else {
        await db.insert(schema.brokerConnections).values({ brokerName: this.name, apiKeyEncrypted: encrypted, paperMode: true });
      }
    } catch (e) {
      console.error(`[${this.name}] Failed to persist rotated refresh token - the next authentication attempt may fail with an already-used token`, e);
    }
  }

  private async fetchQuestrade(path: string): Promise<any> {
    const res = await fetch(`${this.apiServer}${path}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Questrade API Error (${res.status}): ${body}`);
    }
    return res.json();
  }

  async disconnect(): Promise<void> {
    this.accessToken = '';
    this.apiServer = '';
  }

  async account(): Promise<any> {
    return this.fetchQuestrade('v1/accounts');
  }

  async portfolio(): Promise<Portfolio> {
    if (!this.accountNumber) return { cash: 0, buyingPower: 0, equity: 0, positions: [] };

    const [balances, positions] = await Promise.all([
      this.fetchQuestrade(`v1/accounts/${this.accountNumber}/balances`),
      this.positions(),
    ]);

    // combinedBalances aggregates all currencies into the account's base currency - the real
    // figure Questrade's own UI shows as the account total, not a per-currency line item.
    const combined = balances?.combinedBalances?.[0] ?? {};
    return {
      cash: combined.cash ?? 0,
      buyingPower: combined.buyingPower ?? 0,
      equity: combined.totalEquity ?? 0,
      positions,
      realizedPnl: undefined,
      unrealizedPnl: positions.reduce((sum, p) => sum + p.unrealizedPnl, 0),
    };
  }

  async getBuyingPower(): Promise<number> {
    return (await this.portfolio()).buyingPower;
  }

  async orders(): Promise<Order[]> {
    if (!this.accountNumber) return [];
    const res = await this.fetchQuestrade(`v1/accounts/${this.accountNumber}/orders`);
    return (res?.orders ?? []).map((o: any) => ({
      id: String(o.id),
      symbol: o.symbol,
      side: (o.side ?? '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
      type: mapQuestradeOrderType(o.orderType),
      status: mapQuestradeOrderState(o.state),
      quantity: o.totalQuantity ?? 0,
      filledQuantity: o.filledQuantity ?? 0,
      price: o.limitPrice ?? undefined,
      stopPrice: o.stopPrice ?? undefined,
      averageFillPrice: o.avgExecPrice ?? undefined,
      createdAt: o.creationTime ? new Date(o.creationTime) : new Date(),
      updatedAt: o.updateTime ? new Date(o.updateTime) : new Date(),
    }));
  }

  async placeOrder(order: Partial<Order>): Promise<Order> {
    throw new Error("Not implemented: Questrade's order-execution API is restricted to approved partner developers - a retail app cannot place real orders through it regardless of credentials.");
  }

  async modifyOrder(orderId: string, updates: Partial<Order>): Promise<Order> {
    throw new Error("Not implemented: Questrade's order-execution API is restricted to approved partner developers.");
  }

  async cancelOrder(orderId: string): Promise<boolean> { return false; }

  async closePosition(symbol: string): Promise<boolean> {
    throw new Error("Not implemented: Questrade's order-execution API is restricted to approved partner developers - a retail app cannot close positions through it regardless of credentials.");
  }

  async positions(): Promise<Position[]> {
    if (!this.accountNumber) return [];
    const res = await this.fetchQuestrade(`v1/accounts/${this.accountNumber}/positions`);
    return (res?.positions ?? []).map((p: any) => ({
      symbol: p.symbol,
      quantity: p.openQuantity ?? 0,
      entryPrice: p.averageEntryPrice ?? 0,
      currentPrice: p.currentPrice ?? 0,
      marketValue: p.currentMarketValue ?? 0,
      unrealizedPnl: p.openPnl ?? 0,
      unrealizedPnlPercent: p.totalCost ? ((p.openPnl ?? 0) / Math.abs(p.totalCost)) * 100 : 0,
    }));
  }

  private async resolveSymbolId(symbol: string): Promise<number> {
    const cached = this.symbolIdCache.get(symbol);
    if (cached !== undefined) return cached;
    const res = await this.fetchQuestrade(`v1/symbols?names=${encodeURIComponent(symbol)}`);
    const symbolId = res?.symbols?.[0]?.symbolId;
    if (!symbolId) throw new Error(`Questrade: no symbol match found for "${symbol}"`);
    this.symbolIdCache.set(symbol, symbolId);
    return symbolId;
  }

  /** Real Questrade Level 1 quote (GET /v1/markets/quotes/{symbolId}) - see header comment. */
  async getQuote(symbol: string): Promise<Quote> {
    const symbolId = await this.resolveSymbolId(symbol);
    const res = await this.fetchQuestrade(`v1/markets/quotes/${symbolId}`);
    const q = res?.quotes?.[0];
    if (!q) throw new Error(`Questrade: no quote returned for ${symbol}`);
    return {
      symbol,
      bid: q.bidPrice ?? 0,
      ask: q.askPrice ?? 0,
      last: q.lastTradePrice ?? q.bidPrice ?? q.askPrice ?? 0,
      volume: q.volume ?? 0,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Real Questrade historical candles (GET /v1/markets/candles/{symbolId}). Fetches a 3x-limit
   * lookback window (covers weekend/holiday gaps for daily bars, after-hours gaps for intraday)
   * and returns the most recent `limit` candles - never fabricates a bar if fewer are available.
   */
  async getHistoricalCandles(symbol: string, timeframe: string, limit: number): Promise<Candle[]> {
    const mapping = QUESTRADE_INTERVAL_MAP[timeframe] ?? QUESTRADE_INTERVAL_MAP['1Day'];
    const symbolId = await this.resolveSymbolId(symbol);
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - mapping.ms * limit * 3);

    const res = await this.fetchQuestrade(
      `v1/markets/candles/${symbolId}?startTime=${encodeURIComponent(startTime.toISOString())}&endTime=${encodeURIComponent(endTime.toISOString())}&interval=${mapping.interval}`
    );
    const candles: any[] = res?.candles ?? [];
    return candles.slice(-limit).map((c: any) => ({
      timestamp: c.start,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume ?? 0,
    }));
  }
}

function mapQuestradeOrderType(t: string | undefined): Order['type'] {
  switch ((t ?? '').toLowerCase()) {
    case 'limit': return 'LIMIT';
    case 'stopmarket': return 'STOP';
    case 'stoplimit': return 'STOP_LIMIT';
    default: return 'MARKET';
  }
}

function mapQuestradeOrderState(s: string | undefined): Order['status'] {
  switch ((s ?? '').toLowerCase()) {
    case 'executed': return 'FILLED';
    case 'canceled':
    case 'expired':
    case 'rejected': return s?.toLowerCase() === 'rejected' ? 'REJECTED' : 'CANCELED';
    case 'partialexecution': return 'PARTIALLY_FILLED';
    default: return 'PENDING';
  }
}
