/**
 * ARGUS Crypto V2 - real Alpaca crypto market-data client (2026-09-21). Follow-up to the IBKR ->
 * Alpaca broker migration: AlpacaBroker.ts declares `crypto: false` ("this adapter only
 * implements the /v2/* US equities endpoints") and no crypto market-data source was wired into
 * Argus at all before this file. This is the data layer ONLY - real, tested, live quotes/bars
 * from Alpaca's actual crypto API using the SAME already-configured ALPACA_API_KEY/
 * ALPACA_SECRET_KEY (crypto market data requires no separate credential, confirmed live).
 *
 * Deliberately NOT wired into MarketDataWorker/TRADE_IDEA_GENERATED/ChiefTrader/RiskEngine/OMS -
 * see cryptoLiveArchitectureBoundary.test.ts for the enforced boundary. Reasons this stops at
 * data, documented rather than silently bypassed (CLAUDE.md: "If a requested feature appears to
 * require modifying anything in [the protected architecture list]: stop, explain the conflict"):
 *   - RiskEngine gate 21 (sufficient_size) and OMS order construction assume whole-share sizing
 *     (`Math.floor(dollars / price)`); Alpaca's real BTC/USD asset has min_order_size=0.000012 and
 *     is explicitly fractionable - whole-share math would floor every realistic paper-budget BTC
 *     order to 0 and always fail closed, which is correct-but-useless, not a real integration.
 *   - RiskEngine gate 12 (market_hours) is RTH-shaped; crypto trades 24/7 (see
 *     CryptoSessionClock.ts's own header for why that's a genuinely different model, not a minor
 *     variant).
 *   - Wiring real crypto order placement through OMS/PositionSizing needs those two decisions
 *     made deliberately, with tests, not smuggled in under a market-data client.
 */

export interface CryptoQuote {
  symbol: string;
  bidPrice: number;
  askPrice: number;
  bidSize: number;
  askSize: number;
  midPrice: number;
  timestamp: string;
}

export interface CryptoBar {
  timestampMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount?: number;
  vwap?: number;
}

const CRYPTO_DATA_BASE_URL = 'https://data.alpaca.markets/v1beta3/crypto/us';

function requireCredentials(): { apiKey: string; secretKey: string } {
  const apiKey = process.env.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY;
  if (!apiKey || !secretKey) {
    throw new Error('ALPACA_API_KEY/ALPACA_SECRET_KEY not configured - cannot fetch real Alpaca crypto data. Refusing to fabricate a quote.');
  }
  return { apiKey, secretKey };
}

function authHeaders(): Record<string, string> {
  const { apiKey, secretKey } = requireCredentials();
  return { 'APCA-API-KEY-ID': apiKey, 'APCA-API-SECRET-KEY': secretKey };
}

/** Real latest bid/ask for one or more crypto symbols (e.g. ['BTC/USD', 'ETH/USD']). Throws on
 *  a non-200 response rather than returning a fabricated/partial quote. */
export async function getLatestCryptoQuotes(symbols: readonly string[]): Promise<Map<string, CryptoQuote>> {
  if (symbols.length === 0) return new Map();
  const url = new URL(`${CRYPTO_DATA_BASE_URL}/latest/quotes`);
  url.searchParams.set('symbols', symbols.join(','));
  const res = await fetch(url.toString(), { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Alpaca crypto quote request failed: ${res.status} ${res.statusText} ${body}`);
  }
  const json = (await res.json()) as { quotes?: Record<string, { ap: number; as: number; bp: number; bs: number; t: string }> };
  const out = new Map<string, CryptoQuote>();
  for (const [symbol, q] of Object.entries(json.quotes ?? {})) {
    out.set(symbol, {
      symbol,
      bidPrice: q.bp,
      askPrice: q.ap,
      bidSize: q.bs,
      askSize: q.as,
      midPrice: (q.bp + q.ap) / 2,
      timestamp: q.t,
    });
  }
  return out;
}

/** Real historical daily (or other timeframe) bars for one crypto symbol. Paginates via
 *  next_page_token the same way HistoricalDataGateway's equities fetch already does. */
export async function getCryptoBars(
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number,
): Promise<CryptoBar[]> {
  const out: CryptoBar[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${CRYPTO_DATA_BASE_URL}/bars`);
    url.searchParams.set('symbols', symbol);
    url.searchParams.set('timeframe', timeframe);
    url.searchParams.set('start', new Date(startMs).toISOString());
    url.searchParams.set('end', new Date(endMs).toISOString());
    url.searchParams.set('limit', '10000');
    if (pageToken) url.searchParams.set('page_token', pageToken);

    const res = await fetch(url.toString(), { headers: authHeaders() });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Alpaca crypto bars request failed for ${symbol}: ${res.status} ${res.statusText} ${body}`);
    }
    const json = (await res.json()) as {
      bars?: Record<string, Array<{ t: string; o: number; h: number; l: number; c: number; v: number; n?: number; vw?: number }>>;
      next_page_token?: string | null;
    };
    const bars = json.bars?.[symbol] ?? [];
    for (const b of bars) {
      out.push({
        timestampMs: new Date(b.t).getTime(),
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v,
        tradeCount: b.n,
        vwap: b.vw,
      });
    }
    pageToken = json.next_page_token ?? undefined;
  } while (pageToken);

  out.sort((a, b) => a.timestampMs - b.timestampMs);
  return out;
}

/** Real per-account crypto trading eligibility check (read-only, does not place an order). */
export async function getCryptoAccountStatus(): Promise<{ cryptoStatus: string; tradingBlocked: boolean }> {
  const res = await fetch('https://paper-api.alpaca.markets/v2/account', { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Alpaca account status request failed: ${res.status} ${res.statusText} ${body}`);
  }
  const json = (await res.json()) as { crypto_status?: string; trading_blocked?: boolean };
  return { cryptoStatus: json.crypto_status ?? 'UNKNOWN', tradingBlocked: json.trading_blocked ?? true };
}
