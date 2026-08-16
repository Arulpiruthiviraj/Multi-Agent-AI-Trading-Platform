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
import { tradingSafety } from '../../config/tradingSafety';
import crypto from 'crypto';

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

  /**
   * Phase 2C (FINAL_ANALYSIS.md's 4-phase remediation plan) - real corporate-actions safety
   * check. ensureBars()/getBars() above always deal in adjustment='raw' bars (unadjusted for
   * splits/dividends) - a real stock split within the backtest window would silently corrupt
   * every bar before the split date, since a pre-split $400 close and a post-split $100 close for
   * the same company are not comparable without adjustment, and the strategy would see what looks
   * like a real -75% crash that never happened. This makes a separate, uncached, one-off fetch
   * with adjustment='split' for the same range and compares it against the already-cached raw
   * bars; a material difference anywhere means a real corporate action occurred in this window.
   * Deliberately does NOT cache the split-adjusted comparison bars into ohlcv_bars - mixing two
   * different adjustment conventions under the same symbol+timeframe cache key would silently
   * corrupt every other real consumer of that cache (e.g. RiskEngine's correlation lookback).
   * Returns `checked:false` (never a fabricated "clean" verdict) when it cannot actually compare -
   * no credentials, no raw bars yet, or the comparison fetch itself failed.
   */
  async checkForUnadjustedCorporateActions(symbol: string, timeframe: string, startMs: number, endMs: number): Promise<{ clean: boolean; checked: boolean; issues: string[] }> {
    if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
      return { clean: true, checked: false, issues: ['Cannot check for corporate actions - no Alpaca credentials configured.'] };
    }
    const rawBars = await this.getBars(symbol, timeframe, startMs, endMs);
    if (rawBars.length === 0) return { clean: true, checked: false, issues: [] };

    try {
      const splitByTs = new Map<number, number>();
      let pageToken: string | undefined;
      do {
        const url = new URL(`${ALPACA_DATA_HOST}/v2/stocks/${encodeURIComponent(symbol)}/bars`);
        url.searchParams.set('timeframe', timeframe);
        url.searchParams.set('start', new Date(startMs).toISOString());
        url.searchParams.set('end', new Date(endMs).toISOString());
        url.searchParams.set('limit', '10000');
        url.searchParams.set('adjustment', 'split');
        if (pageToken) url.searchParams.set('page_token', pageToken);

        const res = await fetch(url.toString(), {
          headers: { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY }
        });
        if (!res.ok) return { clean: true, checked: false, issues: [`Could not verify - split-adjusted comparison fetch failed: ${res.status}`] };
        const data = await res.json();
        for (const b of (data.bars || [])) splitByTs.set(new Date(b.t).getTime(), b.c);
        pageToken = data.next_page_token || undefined;
      } while (pageToken);

      const issues: string[] = [];
      for (const bar of rawBars) {
        const splitClose = splitByTs.get(bar.timestamp);
        if (splitClose === undefined || bar.close === 0) continue;
        const relDiff = Math.abs(splitClose - bar.close) / bar.close;
        if (relDiff > 0.01) {
          issues.push(`${symbol} ${new Date(bar.timestamp).toISOString().split('T')[0]}: raw close ${bar.close} vs split-adjusted close ${splitClose} (${(relDiff * 100).toFixed(1)}% difference) - likely an unadjusted stock split affecting this bar and everything before it.`);
        }
      }
      return { clean: issues.length === 0, checked: true, issues };
    } catch (e: any) {
      return { clean: true, checked: false, issues: [`Could not verify corporate actions: ${e.message}`] };
    }
  }

  /**
   * Persist a PIT news/agent fact. Rejects look-ahead: publishedAtMs must be <= asOfMs.
   * Backtest replay may only read rows with publishedAtMs <= simulated now.
   */
  async ingestPitLedgerEntry(entry: {
    asOfMs: number;
    publishedAtMs: number;
    symbol: string;
    kind: 'NEWS' | 'NEWS_AGENT' | 'CHIEF_TRADER' | 'AGENT_REASONING';
    agent?: string;
    side?: 'BUY' | 'SELL' | 'HOLD';
    confidence?: number;
    finbertScore?: number;
    impactScore?: number;
    payloadJson?: string;
    source?: string;
  }): Promise<string> {
    if (!Number.isFinite(entry.asOfMs) || !Number.isFinite(entry.publishedAtMs)) {
      throw new Error('PIT ledger requires finite asOfMs and publishedAtMs.');
    }
    if (entry.publishedAtMs > entry.asOfMs) {
      throw new Error(`LOOK_AHEAD_FORBIDDEN: publishedAtMs ${entry.publishedAtMs} is after asOfMs ${entry.asOfMs}. News/LLM text after the bar close cannot be ingested.`);
    }
    const id = crypto.randomUUID();
    await db.insert(schema.pitDecisionLedger).values({
      id,
      asOfMs: entry.asOfMs,
      publishedAtMs: entry.publishedAtMs,
      symbol: entry.symbol,
      kind: entry.kind,
      agent: entry.agent ?? null,
      side: entry.side ?? null,
      confidence: entry.confidence ?? null,
      finbertScore: entry.finbertScore ?? null,
      impactScore: entry.impactScore ?? null,
      payloadJson: entry.payloadJson ?? null,
      source: entry.source ?? null,
      createdAt: new Date().toISOString(),
    });
    return id;
  }

  /** NEWS rows knowable at simulated now, inside the live news-veto window. Never returns later publications. */
  async getPitNewsAsOf(symbol: string, nowMs: number, windowMs: number = tradingSafety.newsVetoWindowMs): Promise<Array<{
    symbol: string;
    impactScore: number | null;
    publishedAtMs: number;
    finbertScore: number | null;
  }>> {
    const windowStart = nowMs - windowMs;
    const rows = await db.select().from(schema.pitDecisionLedger)
      .where(and(
        eq(schema.pitDecisionLedger.kind, 'NEWS'),
        eq(schema.pitDecisionLedger.symbol, symbol),
        lte(schema.pitDecisionLedger.publishedAtMs, nowMs),
        lte(schema.pitDecisionLedger.asOfMs, nowMs),
        gte(schema.pitDecisionLedger.publishedAtMs, windowStart),
      ))
      .orderBy(asc(schema.pitDecisionLedger.publishedAtMs));
    return rows.map(r => ({
      symbol: r.symbol,
      impactScore: r.impactScore,
      publishedAtMs: r.publishedAtMs,
      finbertScore: r.finbertScore,
    }));
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
