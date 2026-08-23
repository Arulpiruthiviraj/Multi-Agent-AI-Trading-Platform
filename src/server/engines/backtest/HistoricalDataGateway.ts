/**
 * ==========================================================
 * Module: HistoricalDataGateway
 *
 * Purpose:
 * Fetches and caches real historical OHLCV bars from Alpaca's market-data
 * API into the ohlcv_bars table, and provides point-in-time-safe read
 * access for the backtest engine.
 *
 * Cache-first: when SQLite already has sufficient coverage for the window,
 * Alpaca is not contacted (avoids 429 storms). On HTTP 429, exponential
 * backoff is armed; callers may still evaluate from cache — never fabricate bars.
 * ==========================================================
 */
import { db } from '../../db';
import * as schema from '../../db/schema';
import { and, eq, gte, lte, asc, ne, sql } from 'drizzle-orm';
import { tradingSafety } from '../../config/tradingSafety';
import { networkEndpoints } from '../../config/networkEndpoints';
import crypto from 'crypto';
import { getRegisteredHistoricalBarProvider } from './historicalBarProvider';

export interface Bar {
  timestamp: number; // epoch ms, bar open time
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Alpaca's real market-data host - distinct from the paper/live trading hosts, since market data
// is not paper/live-scoped the way order execution is. Sourced from config/networkEndpoints.json
// (also used by ingestAlpacaWarehouse.ts, which independently hardcoded the same host before).
const ALPACA_DATA_HOST = networkEndpoints.broker.alpaca.dataBaseUrl;

/** Approximate expected bar count for coverage checks (weekends/holidays reduce real count). */
export function expectedBarCountForWindow(timeframe: string, startMs: number, endMs: number): number {
  const spanMs = Math.max(0, endMs - startMs);
  const dayMs = 86_400_000;
  if (timeframe === '1Day' || timeframe === '1D') {
    return Math.max(1, Math.floor(spanMs / dayMs));
  }
  if (timeframe === '1Min' || timeframe === '1T') {
    return Math.max(1, Math.floor(spanMs / 60_000));
  }
  if (timeframe === '5Min') {
    return Math.max(1, Math.floor(spanMs / (5 * 60_000)));
  }
  return Math.max(1, Math.floor(spanMs / dayMs));
}

export class HistoricalDataGateway {
  private static instance: HistoricalDataGateway;
  /** Shared across symbols so one 429 stops an idea-storm of ensureBars fan-out. */
  private rateLimitedUntilMs = 0;
  private consecutiveRateLimits = 0;
  /** Short-lived in-process cache keyed by symbol|timeframe|bucketed window. */
  private memoryBars = new Map<string, { bars: Bar[]; expiresAt: number }>();
  /** Alpaca pacing: ≥400ms between REST bar requests (~150/min ceiling). */
  private lastAlpacaFetchAtMs = 0;
  private alpacaPaceChain: Promise<void> = Promise.resolve();

  public static getInstance(): HistoricalDataGateway {
    if (!HistoricalDataGateway.instance) HistoricalDataGateway.instance = new HistoricalDataGateway();
    return HistoricalDataGateway.instance;
  }

  /** Test/ops helper — clear the in-process Alpaca bars 429 backoff. */
  clearBarsRateLimitBackoff(): void {
    this.rateLimitedUntilMs = 0;
    this.consecutiveRateLimits = 0;
  }

  getBarsRateLimitedUntilMs(): number {
    return this.rateLimitedUntilMs;
  }

  private memoryKey(symbol: string, timeframe: string, startMs: number, endMs: number): string {
    const startBucket = Math.floor(startMs / 3_600_000);
    const endBucket = Math.floor(endMs / 3_600_000);
    return `${symbol}|${timeframe}|${startBucket}|${endBucket}`;
  }

  private armBarsRateLimitBackoff(retryAfterHeader: string | null): void {
    this.consecutiveRateLimits += 1;
    const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    const exp =
      tradingSafety.quantBarsRateLimitBaseBackoffMs *
      Math.pow(2, Math.min(6, this.consecutiveRateLimits - 1));
    const capped = Math.min(exp, tradingSafety.quantBarsRateLimitMaxBackoffMs);
    const retryAfterMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec * 1000
      : capped;
    this.rateLimitedUntilMs = Math.max(this.rateLimitedUntilMs, Date.now() + retryAfterMs);
  }

  private async persistBars(
    symbol: string,
    timeframe: string,
    bars: Bar[],
    source: string,
    startMs?: number,
    endMs?: number,
  ): Promise<void> {
    for (const b of bars) {
      if (!(b.close > 0) || !Number.isFinite(b.timestamp)) continue;
      await db.insert(schema.ohlcvBars).values({
        id: `${symbol}:${timeframe}:${b.timestamp}`,
        symbol,
        timeframe,
        timestamp: b.timestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        source,
      }).onConflictDoNothing();
    }
    if (startMs != null && endMs != null) {
      this.memoryBars.delete(this.memoryKey(symbol, timeframe, startMs, endMs));
    }
  }

  private async paceAlpacaFetch(): Promise<void> {
    const minGapMs = 400; // ≤150 req/min
    const run = async () => {
      const wait = Math.max(0, minGapMs - (Date.now() - this.lastAlpacaFetchAtMs));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastAlpacaFetchAtMs = Date.now();
    };
    const next = this.alpacaPaceChain.then(run, run);
    this.alpacaPaceChain = next.then(() => undefined, () => undefined);
    await next;
  }

  /**
   * Ensures real bars for [startMs, endMs] are cached locally.
   * When IBKR Gateway is active (registered provider), uses reqHistoricalData — never Alpaca.
   * When Alpaca is the provider path, paces REST (≤150/min) and uses SQLite cache-first.
   * Never fabricates bars.
   */
  async ensureBars(symbol: string, timeframe: string, startMs: number, endMs: number): Promise<void> {
    const existing = await this.getBars(symbol, timeframe, startMs, endMs);
    const expected = expectedBarCountForWindow(timeframe, startMs, endMs);
    const coverage = existing.length / expected;
    const minBars = tradingSafety.regimeMinBars;
    const sufficient =
      existing.length >= minBars
      || coverage >= tradingSafety.quantBarsCacheMinCoverageRatio;

    if (sufficient) {
      this.consecutiveRateLimits = 0;
      return;
    }

    const provider = getRegisteredHistoricalBarProvider();
    if (provider?.id === 'ibkr_gateway') {
      try {
        const fetched = await provider.fetchBars(symbol, timeframe, startMs, endMs);
        if (fetched.length > 0) {
          await this.persistBars(symbol, timeframe, fetched, 'ibkr', startMs, endMs);
          this.consecutiveRateLimits = 0;
          return;
        }
        if (existing.length > 0) return;
        throw new Error(`IBKR historical bars returned empty for ${symbol} (${timeframe})`);
      } catch (e: any) {
        if (existing.length > 0) {
          console.warn(
            `[HistoricalDataGateway] IBKR hist failed for ${symbol} — using ${existing.length} cached bars: ${e?.message || e}`,
          );
          return;
        }
        throw e instanceof Error ? e : new Error(String(e));
      }
    }

    if (Date.now() < this.rateLimitedUntilMs) {
      if (existing.length > 0) return;
      throw new Error(
        `Alpaca bars request rate-limited until ${new Date(this.rateLimitedUntilMs).toISOString()} - failing closed, no fabricated bars.`,
      );
    }

    if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
      if (existing.length > 0) return;
      throw new Error('Historical backfill requires ALPACA_API_KEY/ALPACA_SECRET_KEY - no other real historical data source is wired into Argus.');
    }

    await this.paceAlpacaFetch();

    let pageToken: string | undefined;
    let fetchedAny = false;
    do {
      const url = new URL(`${ALPACA_DATA_HOST}/v2/stocks/${encodeURIComponent(symbol)}/bars`);
      url.searchParams.set('timeframe', timeframe);
      url.searchParams.set('start', new Date(startMs).toISOString());
      url.searchParams.set('end', new Date(endMs).toISOString());
      url.searchParams.set('limit', '10000');
      url.searchParams.set('adjustment', 'raw');
      // Unspecified defaults to the SIP feed, which recent-data requests 403 on unless the
      // account has a paid SIP subscription. The live WebSocket only ever connects to IEX
      // (wss://stream.data.alpaca.markets/v2/iex), so historical bars must match that entitlement.
      url.searchParams.set('feed', 'iex');
      if (pageToken) url.searchParams.set('page_token', pageToken);

      const res = await fetch(url.toString(), {
        headers: {
          'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
          'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
        }
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 429) {
          this.armBarsRateLimitBackoff(res.headers.get('Retry-After'));
          if (existing.length > 0) {
            console.warn(
              `[HistoricalDataGateway] 429 for ${symbol} — using ${existing.length} cached bars; backoff until ${new Date(this.rateLimitedUntilMs).toISOString()}`,
            );
            return;
          }
          throw new Error(`Alpaca bars request failed: 429 Too Many Requests ${body}`);
        }
        throw new Error(`Alpaca bars request failed: ${res.status} ${res.statusText} ${body}`);
      }
      this.consecutiveRateLimits = 0;
      const data = await res.json();
      const bars: any[] = data.bars || [];
      if (bars.length > 0) {
        fetchedAny = true;
        const mapped: Bar[] = bars.map((b: any) => {
          const ts = new Date(b.t).getTime();
          return {
            timestamp: ts,
            open: b.o,
            high: b.h,
            low: b.l,
            close: b.c,
            volume: b.v,
          };
        });
        await this.persistBars(symbol, timeframe, mapped, 'alpaca', startMs, endMs);
      }
      pageToken = data.next_page_token || undefined;
      if (pageToken) await this.paceAlpacaFetch();
    } while (pageToken);

    this.memoryBars.delete(this.memoryKey(symbol, timeframe, startMs, endMs));

    if (!fetchedAny) {
      const after = await this.getBars(symbol, timeframe, startMs, endMs);
      if (after.length === 0) {
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
        url.searchParams.set('feed', 'iex');
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
    kind: 'NEWS' | 'NEWS_AGENT' | 'CHIEF_TRADER' | 'AGENT_REASONING' | 'DATA_QUALITY';
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

  /**
   * Agent / ChiefTrader PIT rows knowable at simulated now, after windowStartMs.
   * NEWS rows are queried separately (news-veto window). Never returns later publications.
   */
  async getPitAiRowsAsOf(symbol: string, nowMs: number, windowStartMs: number): Promise<Array<{
    kind: string;
    agent: string | null;
    side: string | null;
    confidence: number | null;
    publishedAtMs: number;
    payloadJson: string | null;
    finbertScore: number | null;
  }>> {
    if (!Number.isFinite(nowMs) || !Number.isFinite(windowStartMs) || windowStartMs > nowMs) {
      return [];
    }
    const rows = await db.select().from(schema.pitDecisionLedger)
      .where(and(
        ne(schema.pitDecisionLedger.kind, 'NEWS'),
        eq(schema.pitDecisionLedger.symbol, symbol),
        lte(schema.pitDecisionLedger.publishedAtMs, nowMs),
        lte(schema.pitDecisionLedger.asOfMs, nowMs),
        gte(schema.pitDecisionLedger.publishedAtMs, windowStartMs),
      ))
      .orderBy(asc(schema.pitDecisionLedger.publishedAtMs));
    return rows.map(r => ({
      kind: r.kind,
      agent: r.agent,
      side: r.side,
      confidence: r.confidence,
      publishedAtMs: r.publishedAtMs,
      payloadJson: r.payloadJson,
      finbertScore: r.finbertScore,
    }));
  }

  /** Real, ordered, point-in-time bars for a symbol/timeframe/range. No fabrication. */
  async getBars(symbol: string, timeframe: string, startMs: number, endMs: number): Promise<Bar[]> {
    const key = this.memoryKey(symbol, timeframe, startMs, endMs);
    const hit = this.memoryBars.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      return hit.bars;
    }
    const rows = await db.select().from(schema.ohlcvBars)
      .where(and(
        eq(schema.ohlcvBars.symbol, symbol),
        eq(schema.ohlcvBars.timeframe, timeframe),
        gte(schema.ohlcvBars.timestamp, startMs),
        lte(schema.ohlcvBars.timestamp, endMs)
      ))
      .orderBy(asc(schema.ohlcvBars.timestamp));
    const bars = rows.map(r => ({ timestamp: r.timestamp, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
    this.memoryBars.set(key, { bars, expiresAt: Date.now() + 60_000 });
    return bars;
  }
}

export const historicalDataGateway = HistoricalDataGateway.getInstance();
