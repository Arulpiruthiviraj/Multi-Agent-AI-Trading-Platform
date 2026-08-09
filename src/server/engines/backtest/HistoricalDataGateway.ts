/**
 * ==========================================================
 * Module: HistoricalDataGateway
 *
 * Purpose:
 * Fetches and caches real historical OHLCV bars from Alpaca's market-data
 * API into the ohlcv_bars table, and provides point-in-time-safe read
 * access for the backtest engine.
 *
 * There is no other real historical data source wired into Argus - this
 * throws rather than fabricating bars if ALPACA_API_KEY/SECRET are absent.
 * ==========================================================
 */
import { db } from '../../db';
import * as schema from '../../db/schema';
import { and, eq, gte, lte, asc, sql } from 'drizzle-orm';

export interface Bar {
  timestamp: number; // epoch ms, bar open time
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Alpaca's real market-data host - distinct from the paper/live trading hosts, since market data
// is not paper/live-scoped the way order execution is.
const ALPACA_DATA_HOST = 'https://data.alpaca.markets';

export class HistoricalDataGateway {
  private static instance: HistoricalDataGateway;
  public static getInstance(): HistoricalDataGateway {
    if (!HistoricalDataGateway.instance) HistoricalDataGateway.instance = new HistoricalDataGateway();
    return HistoricalDataGateway.instance;
  }

  /**
   * Ensures real bars for [startMs, endMs] are cached locally, fetching from Alpaca if the
   * cached count looks incomplete. Throws if no Alpaca credentials are configured - never
   * fabricates a bar.
   */
  async ensureBars(symbol: string, timeframe: string, startMs: number, endMs: number): Promise<void> {
    if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
      throw new Error('Historical backfill requires ALPACA_API_KEY/ALPACA_SECRET_KEY - no other real historical data source is wired into Argus.');
    }

    let pageToken: string | undefined;
    let fetchedAny = false;
    do {
      const url = new URL(`${ALPACA_DATA_HOST}/v2/stocks/${encodeURIComponent(symbol)}/bars`);
      url.searchParams.set('timeframe', timeframe);
      url.searchParams.set('start', new Date(startMs).toISOString());
      url.searchParams.set('end', new Date(endMs).toISOString());
      url.searchParams.set('limit', '10000');
      url.searchParams.set('adjustment', 'raw');
      if (pageToken) url.searchParams.set('page_token', pageToken);

      const res = await fetch(url.toString(), {
        headers: {
          'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
          'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
        }
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Alpaca bars request failed: ${res.status} ${res.statusText} ${body}`);
      }
      const data = await res.json();
      const bars: any[] = data.bars || [];
      if (bars.length > 0) {
        fetchedAny = true;
        const rows = bars.map(b => {
          const ts = new Date(b.t).getTime();
          return {
            id: `${symbol}:${timeframe}:${ts}`,
            symbol,
            timeframe,
            timestamp: ts,
            open: b.o,
            high: b.h,
            low: b.l,
            close: b.c,
            volume: b.v,
            source: 'alpaca',
          };
        });
        for (const row of rows) {
          await db.insert(schema.ohlcvBars).values(row).onConflictDoNothing();
        }
      }
      pageToken = data.next_page_token || undefined;
    } while (pageToken);

    if (!fetchedAny) {
      const existing = await this.getBars(symbol, timeframe, startMs, endMs);
      if (existing.length === 0) {
        throw new Error(`No historical bars available for ${symbol} (${timeframe}) between ${new Date(startMs).toISOString()} and ${new Date(endMs).toISOString()}.`);
      }
    }
  }

  /** Real, ordered, point-in-time bars for a symbol/timeframe/range. No fabrication. */
  async getBars(symbol: string, timeframe: string, startMs: number, endMs: number): Promise<Bar[]> {
    const rows = await db.select().from(schema.ohlcvBars)
      .where(and(
        eq(schema.ohlcvBars.symbol, symbol),
        eq(schema.ohlcvBars.timeframe, timeframe),
        gte(schema.ohlcvBars.timestamp, startMs),
        lte(schema.ohlcvBars.timestamp, endMs)
      ))
      .orderBy(asc(schema.ohlcvBars.timestamp));
    return rows.map(r => ({ timestamp: r.timestamp, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
  }
}

export const historicalDataGateway = HistoricalDataGateway.getInstance();
