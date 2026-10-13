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
import { histRequestStore, newHistRequestContext, finalizeHistRequest, type HistRequestContext } from '../../data/historicalRequestTelemetry';
import { db, sqliteDb } from '../../db';
import * as schema from '../../db/schema';
import { and, eq, gte, lte, asc, ne, sql } from 'drizzle-orm';
import { tradingSafety } from '../../config/tradingSafety';
import { networkEndpoints } from '../../config/networkEndpoints';
import crypto from 'crypto';
import { getRegisteredHistoricalBarProvider } from './historicalBarProvider';
import { minutesInTimezone } from '../../replay/marketSession';
import { replaySafety } from '../../replay/replaySafety';
import { TRADING_TIMEZONE } from '../../core/TradingCalendar';

/**
 * P1-1 (2026-10-04 remediation): a '1Day' bar's own timestamp is its session OPEN, so a bar fetched
 * with end=now mid-session is still forming - it is only truly final once that trading day's
 * regular session has closed. Reuses the same NY-calendar-date comparison already established by
 * marketSession.ts rather than a second, independent timezone implementation. A bar for a date
 * strictly before "now"'s own calendar date is always final (a later calendar day has started, so
 * that earlier day is over); a bar for "now"'s own date is final only once past the session close
 * minute.
 */
export function isDailyBarFinal(barTimestampMs: number, nowMs: number, timeZone: string): boolean {
  const barDateStr = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(barTimestampMs));
  const nowDateStr = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
  if (nowDateStr !== barDateStr) return true;
  return minutesInTimezone(nowMs, timeZone) >= replaySafety.regularSessionEndMinutes;
}

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

/**
 * 2026-10-12 (duplicate-bars defect): ohlcv_bars ids are `${symbol}:${timeframe}:${timestamp}` and the
 * two providers stamp the SAME daily session differently (ibkr 00:00Z, alpaca 04:00Z/05:00Z NY
 * midnight), so a symbol fetched through both held every trading day twice (77 of 728 symbols
 * live), doubling bar counts and corrupting every indicator. The stored rows are left untouched
 * (history is append-only evidence); the READ path returns exactly one bar per UTC calendar day for
 * daily timeframes - the later-stamped (NY-midnight) bar wins, a deterministic source-agnostic rule.
 * Intraday timeframes pass through unchanged. Input is timestamp-ascending, output stays ascending.
 */
export function dedupeDailyBarsBySession<T extends { timestamp: number }>(timeframe: string, bars: T[]): T[] {
  if (timeframe !== '1Day' && timeframe !== '1D') return bars;
  const byDay = new Map<number, T>();
  for (const b of bars) {
    const day = Math.floor(b.timestamp / 86_400_000);
    const prev = byDay.get(day);
    if (!prev || b.timestamp > prev.timestamp) byDay.set(day, b);
  }
  return byDay.size === bars.length ? bars : [...byDay.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export class HistoricalDataGateway {
  private static instance: HistoricalDataGateway;
  /** Shared across symbols so one 429 stops an idea-storm of ensureBars fan-out. */
  private rateLimitedUntilMs = 0;
  private consecutiveRateLimits = 0;
  /**
   * Short-lived in-process cache keyed by symbol|timeframe|bucketed window.
   *
   * Bounded-eviction fix (2026-09-14, P1-A remediation Patch B - a real, standalone defect found
   * while investigating P1-A, tracked separately since it was not the proven cause of the RSS
   * growth reproduced there): this Map was SET on every getBars() call (hit or miss) but only
   * DELETED by persistBars() after a successful fetch actually wrote new bars for that exact
   * window. A window that never gets a successful fetch (no data for a synthetic/delisted symbol,
   * or simply a window nothing ever re-queries) had no active eviction path at all beyond a lazy
   * expiresAt check that only fires if the SAME key is read again - unlikely across the wide
   * timestamp spread real prediction history covers. Confirmed via an isolated harness: 108K
   * predictions grew this map to 36,922 entries with zero shrinkage across repeated cycles.
   * cacheGet()/cacheSet() below enforce a real LRU bound (historicalBarsMemoryCacheMaxEntries) -
   * see that config field's own doc comment for how the bound was chosen.
   */
  private memoryBars = new Map<string, { bars: Bar[]; expiresAt: number }>();

  private cacheGet(key: string): { bars: Bar[]; expiresAt: number } | undefined {
    const hit = this.memoryBars.get(key);
    if (!hit) return undefined;
    // Move to the end (most-recently-used) so eviction below correctly drops the LEAST recently
    // used entry, not just the least recently INSERTED one.
    this.memoryBars.delete(key);
    this.memoryBars.set(key, hit);
    return hit;
  }

  private cacheSet(key: string, value: { bars: Bar[]; expiresAt: number }): void {
    this.memoryBars.delete(key); // re-inserting moves it to the MRU end even on an overwrite
    this.memoryBars.set(key, value);
    const maxEntries = tradingSafety.historicalBarsMemoryCacheMaxEntries;
    while (this.memoryBars.size > maxEntries) {
      const oldestKey = this.memoryBars.keys().next().value;
      if (oldestKey === undefined) break;
      this.memoryBars.delete(oldestKey);
    }
  }

  /** Test/ops helper - real cache size, for the same offline-forensic measurement pattern used
   *  throughout this remediation (never called from a hot path). */
  getMemoryBarsCacheSize(): number {
    return this.memoryBars.size;
  }
  /** Alpaca pacing: ≥400ms between REST bar requests (~150/min ceiling). */
  private lastAlpacaFetchAtMs = 0;
  private alpacaPaceChain: Promise<void> = Promise.resolve();

  /**
   * In-flight provider-refresh coalescing, keyed by symbol|timeframe|hour-bucket window.
   * paceAlpacaFetch() already serializes provider REST calls (no simultaneous bursts), but
   * without coalescing every concurrent caller for the same window would still fire its OWN
   * redundant fetch back-to-back - a self-inflicted mini-storm when, e.g., QuantSignalAgent,
   * RiskEngine and MissedOpportunityEvaluator evaluate the same symbol in the same cycle.
   * The public ensureBars() below is a thin wrapper that shares one in-flight
   * ensureBarsInner() promise per window. Bounded three ways: (1) the 2026-10-12 inner
   * timeout (quantBarsInnerFetchTimeoutMs) fails a stalled inner FIRST with
   * HISTORICAL_INNER_FETCH_TIMEOUT and releases the entry for a fresh attempt; (2) the
   * entry is removed on settle; (3) a TTL (quantBarsCoalesceEntryMaxAgeMs) marks it overdue
   * with a loud warn as a backstop. A late-settling zombie's cache writes are
   * entry-identity-guarded (isCurrentEntry) and skipped. A shared rejection is shared
   * honestly - every coalesced caller sees the same error; none gets silent stale data.
   */
  private inflightEnsureBars = new Map<string, { promise: Promise<void>; overdue: boolean }>();

  /**
   * A request is "present-time" when its window ends at/near now - i.e. endMs is not
   * clearly before now. quantBarsTailFreshnessToleranceMs doubles as the "clearly before"
   * boundary: backtest/PIT-replay windows ending more than the tolerance ago are
   * historical and must never be held to today's freshness.
   */
  private isPresentTimeRequest(endMs: number, nowMs: number): boolean {
    return endMs >= nowMs - tradingSafety.quantBarsTailFreshnessToleranceMs;
  }

  /**
   * Stale-tail check (2026-10-09 remediation): the newest cached bar's timestamp must be
   * within quantBarsTailFreshnessToleranceMs of now for a present-time request. `bars`
   * must be timestamp-ascending (as getBars() returns). Historical end-date requests are
   * exempt - asking for data "as of" a past date must not demand today's freshness.
   */
  private isCacheTailFresh(bars: Bar[], endMs: number, nowMs: number): boolean {
    if (bars.length === 0) return false;
    if (!this.isPresentTimeRequest(endMs, nowMs)) return true;
    return bars[bars.length - 1].timestamp >= nowMs - tradingSafety.quantBarsTailFreshnessToleranceMs;
  }

  /**
   * Stale-tail honesty check: after a provider refresh triggered by a stale tail, the
   * newest cached bar must actually be fresh now. A provider failure, an empty provider
   * response, or old-only bars surface as a loud DATA_STALE error - the old rows stay
   * as-is in ohlcv_bars (missing stays missing; nothing is fabricated) but are never
   * presented as fresh.
   */
  private async verifyStaleTailMoved(symbol: string, timeframe: string, startMs: number, endMs: number): Promise<void> {
    const after = await this.getBars(symbol, timeframe, startMs, endMs);
    if (this.isCacheTailFresh(after, endMs, Date.now())) {
      this.consecutiveRateLimits = 0;
      return;
    }
    const tailTs = after.length > 0 ? after[after.length - 1].timestamp : NaN;
    throw new Error(
      `DATA_STALE: ${symbol} (${timeframe}) - provider refresh did not move a stale cache tail (newest cached bar: ${Number.isFinite(tailTs) ? new Date(tailTs).toISOString() : 'none'}, tolerance quantBarsTailFreshnessToleranceMs=${tradingSafety.quantBarsTailFreshnessToleranceMs}ms). Old data is not relabeled fresh.`,
    );
  }

  public static getInstance(): HistoricalDataGateway {
    if (!HistoricalDataGateway.instance) HistoricalDataGateway.instance = new HistoricalDataGateway();
    return HistoricalDataGateway.instance;
  }

  /** Test/ops helper — clear the in-process Alpaca bars 429 backoff. */
  clearBarsRateLimitBackoff(): void {
    this.rateLimitedUntilMs = 0;
    this.consecutiveRateLimits = 0;
  }

  /**
   * Drop every cached bar window. For callers that change ohlcv_bars outside this gateway
   * (ensureBars already invalidates its own window): the cache is keyed by hour bucket, so a
   * stale bucket would otherwise be served for up to its 60s TTL.
   */
  clearBarsMemoryCache(): void {
    this.memoryBars.clear();
  }

  getBarsRateLimitedUntilMs(): number {
    return this.rateLimitedUntilMs;
  }

  private memoryKey(symbol: string, timeframe: string, startMs: number, endMs: number): string {
    // 2026-10-12 (D1): hour-bucketed keys to bound memory. 2026-10-11 (#10) used exact
    // (startMs,endMs) keys to fix a collision bug, but sliding-window callers (quant
    // path) generated a unique key per call, filling the 5000-entry LRU with ~1.25GB
    // and OOMing the soak (Worker F D1). Hour bucketing bounds the key space; the
    // hit-path filter in getBars() preserves #10's correctness — cached bars are
    // always filtered to the requested [startMs, endMs], so a wider-warmed bucket
    // never leaks post-cutoff bars to a narrower query. On miss, getBars() fetches
    // the FULL bucket range so any sub-range query hits.
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
    const isDailyTimeframe = timeframe === '1Day' || timeframe === '1D';
    const now = Date.now();
    for (const b of bars) {
      if (!(b.close > 0) || !Number.isFinite(b.timestamp)) continue;
      // P1-1 (2026-10-04): a still-forming current-day daily bar is marked provisional rather than
      // frozen as final. persistBars() may refresh a row this process itself wrote as provisional
      // (the WHERE clause below), but a bar already written non-provisional (the stable, completed
      // case - and every intraday-timeframe bar, which is never partial once returned) is never
      // touched again, matching "never overwrite immutable historical bars indiscriminately."
      const provisional = isDailyTimeframe && !isDailyBarFinal(b.timestamp, now, TRADING_TIMEZONE) ? 1 : 0;
      sqliteDb.prepare(
        `INSERT INTO ohlcv_bars (id, symbol, timeframe, timestamp, open, high, low, close, volume, source, provisional)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
           volume=excluded.volume, source=excluded.source, provisional=excluded.provisional
         WHERE ohlcv_bars.provisional = 1`,
      ).run(`${symbol}:${timeframe}:${b.timestamp}`, symbol, timeframe, b.timestamp, b.open, b.high, b.low, b.close, b.volume, source, provisional);
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
   * Concurrent calls for the same symbol/timeframe/window share one in-flight provider
   * fetch (inflightEnsureBars) instead of each firing a redundant one back-to-back.
   * Never fabricates bars.
   */
  async ensureBars(symbol: string, timeframe: string, startMs: number, endMs: number, opts?: { traceId?: string | null }): Promise<void> {
    const coalesceKey = this.memoryKey(symbol, timeframe, startMs, endMs);
    const inFlight = this.inflightEnsureBars.get(coalesceKey);
    if (inFlight) {
      const waiterCtx = newHistRequestContext({ symbol, timeframe, startMs, endMs, role: 'COALESCED', traceId: opts?.traceId ?? null });
      const waitStart = performance.now();
      // 2026-10-11 (#13): caller-side timeout for coalesced waiters. The shared entry
      // is retained until the inner settles (never deleted by TTL), so an overdue entry
      // does not cause duplicate provider work — but a waiter should not hang forever
      // on a stalled inner either. Each waiter races the shared promise against its own
      // timeout; the shared entry itself is untouched.
      const callerTimeoutMs = tradingSafety.quantBarsCoalesceEntryMaxAgeMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          inFlight.promise,
          new Promise<void>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(
                `[HistoricalDataGateway] COALESCE_CALLER_TIMEOUT for ${symbol} (${timeframe}): ` +
                `coalesced waiter exceeded ${callerTimeoutMs}ms awaiting the in-flight ensureBars. ` +
                `The shared entry is retained (no duplicate fetch); this caller is released.`,
              ));
            }, callerTimeoutMs);
          }),
        ]);
        waiterCtx.coalesceWaitMs = performance.now() - waitStart;
        this.finalizeTelemetry(waiterCtx, 'OK', null);
      } catch (coalesceErr) {
        waiterCtx.coalesceWaitMs = performance.now() - waitStart;
        this.finalizeTelemetry(waiterCtx, this.terminalFromError(coalesceErr), String((coalesceErr as Error)?.message ?? coalesceErr));
        throw coalesceErr;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      return;
    }
    const ownerCtx = newHistRequestContext({ symbol, timeframe, startMs, endMs, role: 'OWNER', traceId: opts?.traceId ?? null, expectedBars: expectedBarCountForWindow(timeframe, startMs, endMs) });
    let ownerFinalized = false;
    // 2026-10-12 (M2): the inner-timeout race owns an AbortController, aborted BEFORE the
    // timeout rejection is delivered so the inner's real network work is cancelled, not just
    // abandoned. The Alpaca REST path below honors the signal. The IBKR path CANNOT be
    // cancelled: IbkrSocketSession.requestHistoricalBars (behind the histChain) exposes a bare
    // Promise with no AbortSignal parameter - its internal ib.cancelHistoricalData(reqId) fires
    // only on its own internal timer - and HistoricalBarProvider.fetchBars has no signal slot,
    // so threading a fake signal there would be a lie. An IBKR-side stalled inner therefore
    // remains a true zombie; its late writes stay fully guarded by isCurrentEntry() at the
    // entry-release site, exactly as before.
    const innerAbort = new AbortController();
    // 2026-10-12 (L1): entry-identity replaces the old per-key generation counter (an
    // unbounded Map). isCurrentEntry() compares the map's CURRENT entry against THIS
    // attempt's entry object by identity: a late-settling zombie holds a DIFFERENT entry
    // object, so it can never mistake a newer attempt for its own. Identity cannot collide
    // the way a recycled generation number could, and there is no per-key counter map left
    // to bound - the entry is removed on settle at the release site below.
    const entry: { promise: Promise<void>; overdue: boolean } = { promise: Promise.resolve(), overdue: false };
    const isCurrentEntry = () => this.inflightEnsureBars.get(coalesceKey) === entry;
    const inner = histRequestStore.run(ownerCtx, () => this.ensureBarsInner(symbol, timeframe, startMs, endMs, isCurrentEntry, innerAbort.signal));
    // A rejected zombie must never surface as an unhandled rejection after the timeout below
    // wins the race: attach a no-op catch to the raw inner promise. Its late cache writes are
    // already entry-identity-guarded; its late errors are intentionally dropped (the timeout error
    // is what callers observed).
    // Late settlement after the owner already finalized (inner timeout / caller released): record it once.
    inner.then(
      () => { if (ownerFinalized) this.finalizeTelemetry(ownerCtx, 'LATE_SETTLEMENT', 'inner settled after the request was already finalized'); },
      (e) => { if (ownerFinalized) this.finalizeTelemetry(ownerCtx, 'LATE_SETTLEMENT', String((e as Error)?.message ?? e)); },
    );
    inner.catch(() => {});
    // 2026-10-12 (Oct 12 forensic): real bounded timeout on the INNER provider operation.
    // A stalled inner previously wedged this window's entry until the 300s caller-side
    // timeout (COALESCE_CALLER_TIMEOUT). Now the inner fails first with the distinct
    // HISTORICAL_INNER_FETCH_TIMEOUT, the entry is released via the finally below, and a
    // fresh attempt can proceed immediately. This does NOT lower the caller timeout.
    // 2026-10-12 (M2): the timeout ABORTS the inner's real network work (innerAbort.abort())
    // before rejecting - the Alpaca fetch below honors the signal, so no zombie fetch keeps
    // burning provider quota after the timeout. The IBKR path has no cancellation API (see
    // the innerAbort comment above) and remains a true zombie - still entry-identity-guarded
    // against zombie writes at the release site.
    const innerTimeoutMs = tradingSafety.quantBarsInnerFetchTimeoutMs;
    let innerTimer: ReturnType<typeof setTimeout> | undefined;
    const run = (async (): Promise<void> => {
      try {
        await Promise.race([
          inner,
          new Promise<void>((_, reject) => {
            innerTimer = setTimeout(() => {
              innerAbort.abort();
              reject(new Error(
                `[HistoricalDataGateway] HISTORICAL_INNER_FETCH_TIMEOUT for ${symbol} (${timeframe}): ` +
                `inner provider operation exceeded quantBarsInnerFetchTimeoutMs=${innerTimeoutMs}ms. ` +
                `The inner's cancellable network work was aborted; the coalescing entry is released ` +
                `so a fresh attempt can proceed; a late-settling zombie is entry-identity-guarded ` +
                `and cannot clobber newer cache entries.`,
              ));
            }, innerTimeoutMs);
          }),
        ]);
      } finally {
        if (innerTimer !== undefined) clearTimeout(innerTimer);
      }
    })();
    // The raced promise is the shared entry so coalesced waiters observe the timeout too.
    entry.promise = run;
    this.inflightEnsureBars.set(coalesceKey, entry);
    // 2026-10-11 (#13) + 2026-10-12: liveness backstop for the coalescing entry. The inner
    // now has its own timeout (quantBarsInnerFetchTimeoutMs, normally fires first), but a
    // wedged edge case must never hold the entry FOREVER. Past quantBarsCoalesceEntryMaxAgeMs
    // the entry is marked OVERDUE with a loud warn — but RETAINED until the inner settles.
    // Deleting it (the old behavior) caused duplicate provider work (new callers
    // started fresh fetches) and let the zombie inner's finally-clause clobber the
    // newer fetch's cache via a stale identity-guarded delete. Retention + the
    // caller-side timeout above gives waiters their own bound without deleting the
    // shared entry. unref'd so a wedged entry never holds the process open on its own.
    const maxAgeMs = tradingSafety.quantBarsCoalesceEntryMaxAgeMs;
    const overdueTimer = setTimeout(() => {
      const current = this.inflightEnsureBars.get(coalesceKey);
      if (current === entry && !current.overdue) {
        current.overdue = true;
        console.warn(
          `[HistoricalDataGateway] COALESCE_ENTRY_OVERDUE for ${symbol} (${timeframe}): ` +
          `in-flight ensureBars exceeded quantBarsCoalesceEntryMaxAgeMs=${maxAgeMs}ms - the ` +
          `provider call is stalled (no timeout/cancel path). Entry RETAINED (not evicted) ` +
          `until the inner settles; coalesced waiters get their own caller-side timeout.`,
        );
      }
    }, maxAgeMs);
    if (typeof (overdueTimer as unknown as { unref?: unknown }).unref === 'function') {
      (overdueTimer as unknown as { unref: () => void }).unref();
    }
    try {
      await run;
      ownerFinalized = true;
      this.finalizeTelemetry(ownerCtx, ownerCtx.cacheHit ? 'CACHE_HIT' : 'OK', null);
    } catch (ownerErr) {
      ownerFinalized = true;
      this.finalizeTelemetry(ownerCtx, this.terminalFromError(ownerErr), String((ownerErr as Error)?.message ?? ownerErr));
      throw ownerErr;
    } finally {
      clearTimeout(overdueTimer);
      // Generation-guarded: never delete a newer entry.
      if (this.inflightEnsureBars.get(coalesceKey) === entry) {
        this.inflightEnsureBars.delete(coalesceKey);
      }
    }
  }

  private terminalFromError(e: unknown): string {
    const m = String((e as Error)?.message ?? e);
    if (/HISTORICAL_INNER_FETCH_TIMEOUT/.test(m)) return 'HISTORICAL_INNER_FETCH_TIMEOUT';
    if (/COALESCE_CALLER_TIMEOUT/.test(m)) return 'COALESCE_CALLER_TIMEOUT';
    if (/DATA_STALE/.test(m)) return 'DATA_STALE';
    if (/No historical bars available/.test(m)) return 'NO_DATA';
    return 'ERROR';
  }

  /** Fail-open telemetry sink (never throws, never delays the data request). */
  private finalizeTelemetry(ctx: HistRequestContext, terminalStatus: string, reason: string | null): void {
    try {
      finalizeHistRequest(
        ctx,
        { terminalStatus, reason },
        {
          freshnessToleranceMs: tradingSafety.quantBarsTailFreshnessToleranceMs,
          delayedMaxMs: tradingSafety.quantBarsTailFreshnessToleranceMs * 8,
          minCoverage: tradingSafety.quantBarsCacheMinCoverageRatio,
        },
      );
    } catch { /* fail-open */ }
  }

  /**
   * The real ensureBars() body. See the stale-tail gate below: a count/coverage-sufficient
   * cache whose newest bar is older than quantBarsTailFreshnessToleranceMs (present-time
   * request only) falls through to a provider refresh instead of returning early.
   */
  private async ensureBarsInner(
    symbol: string,
    timeframe: string,
    startMs: number,
    endMs: number,
    isCurrentEntry: () => boolean = () => true,
    // 2026-10-12 (M2): aborted by the HISTORICAL_INNER_FETCH_TIMEOUT race in ensureBars().
    // Combined with the per-page request timeout below so the timeout cancels the real HTTP
    // request instead of abandoning it as a zombie fetch.
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const telCtx = histRequestStore.getStore();
    const cacheT0 = performance.now();
    const existing = await this.getBars(symbol, timeframe, startMs, endMs);
    const expected = expectedBarCountForWindow(timeframe, startMs, endMs);
    const coverage = existing.length / expected;
    if (telCtx) {
      telCtx.cacheNormalizationMs = performance.now() - cacheT0;
      telCtx.cacheBarCount = existing.length;
      telCtx.cacheLatestBarMs = existing.length > 0 ? existing[existing.length - 1].timestamp : null;
      telCtx.cacheCoverage = coverage;
      telCtx.expectedBars = expected;
    }
    const minBars = tradingSafety.regimeMinBars;
    const sufficient =
      existing.length >= minBars
      || coverage >= tradingSafety.quantBarsCacheMinCoverageRatio;

    // Stale-tail gate (2026-10-09; Oct-9 missed-opportunity forensic: 508/972 late bar-input
    // records carried a latest timestamp >7 days old). Count/coverage alone no longer
    // accepts the cache for a present-time request. Fresh tail -> accept (existing behavior
    // preserved, consecutiveRateLimits reset as before). Stale tail -> fall through to the
    // provider refresh below - do NOT return early. Historical end-date requests
    // (backtest/PIT replay windows) are exempt via isCacheTailFresh(). The staleTail flag
    // also flips every "provider failed, use cached" fallback below into an honest surface:
    // old data is never relabeled fresh.
    const staleTail = sufficient && !this.isCacheTailFresh(existing, endMs, Date.now());

    if (sufficient && !staleTail) {
      this.consecutiveRateLimits = 0;
      if (telCtx) { telCtx.cacheHit = true; telCtx.provider = 'cache'; telCtx.validBars = existing.length; }
      return;
    }
    if (staleTail) {
      console.warn(
        `[HistoricalDataGateway] STALE_TAIL for ${symbol} (${timeframe}): ${existing.length} cached bars pass count/coverage but newest bar is ${new Date(existing[existing.length - 1].timestamp).toISOString()} - older than quantBarsTailFreshnessToleranceMs=${tradingSafety.quantBarsTailFreshnessToleranceMs}ms. Falling through to provider refresh; old data will not be relabeled fresh.`,
      );
    }

    // Isolation fix (2026-09-15, same-day follow-up to the synthetic certification mandate): a
    // synthetic simulation session's own isolated DB starts with zero bars for any timeframe the
    // simulator itself doesn't write - the simulator only ever writes '1Min'/source=
    // 'synthetic_simulation' bars, never '1Day' - so every real caller of this class that requests
    // '1Day' bars (QuantSignalAgent, at TIMEFRAME='1Day') found "insufficient" cache on every single
    // synthetic run and fell through to a REAL, live Alpaca REST fetch below, using this process's
    // real ALPACA_API_KEY/ALPACA_SECRET_KEY (never stripped from a synthetic child's env - it only
    // strips LIVE_ARM and forces a handful of discovery-loop flags off, see marketOpen.ts's
    // buildChildEnv()). Confirmed live: an isolated CERTIFIED_BULLISH_ENTRY_EXIT run's own temp DB
    // held 275 real 'alpaca' '1Day' SPY bars (Aug 2025-Sep 2026) fetched live during that exact run,
    // and JavaCoreEnsemble's regime/vote output was reading THAT real data, not the synthetic
    // scenario at all - explaining why it read BEARISH_TREND/SIDEWAYS_RANGE identically across every
    // seed regardless of scenario. This never touched production (data/argus.db is untouched; the
    // isolated DB's own temp file is what received the real fetch), but it silently violated "no
    // real network reliance" for a claimed-deterministic simulation and silently invalidated every
    // JavaCoreEnsemble-sourced finding from every synthetic certification run before this fix. Fail
    // closed and loud instead of silently substituting real data for synthetic: same principle
    // already applied to NewsEngine/FundamentalAgent/MacroAgent for this same reason (see
    // SyntheticSessionEngine's own determinism-fix history) - "the honest fix is to not run against
    // real data during synthetic sessions, not to fabricate a stand-in." Scoped narrowly to
    // SYNTHETIC_SIMULATION specifically (not the broader isIsolationRequiredContext(), which also
    // covers NODE_ENV=test/VITEST=true and would wrongly break every existing Vitest test in this
    // file that legitimately exercises this fetch path against a mocked fetch).
    if (process.env.SYNTHETIC_SIMULATION === 'true') {
      if (existing.length > 0) return;
      throw new Error(
        `HistoricalDataGateway refuses a real network fetch for ${symbol} (${timeframe}) during a synthetic simulation session (SYNTHETIC_SIMULATION=true) - no real Alpaca/IBKR historical-bar call is made. The synthetic session must provide its own bars for any timeframe a caller needs, or that caller must not run during synthetic sessions.`,
      );
    }

    const provider = getRegisteredHistoricalBarProvider();
    if (provider?.id === 'ibkr_gateway') {
      try {
        if (telCtx) telCtx.provider = 'ibkr';
        const fetched = await provider.fetchBars(symbol, timeframe, startMs, endMs);
        if (telCtx) {
          telCtx.barsReturned = fetched.length;
          telCtx.validBars = fetched.filter((b) => Number.isFinite(b.timestamp) && Number.isFinite(b.close) && b.close > 0).length;
          if (fetched.length > 0) {
            telCtx.cacheLatestBarMs = Math.max(...fetched.map((b) => b.timestamp));
            telCtx.cacheCoverage = telCtx.validBars / expected;
          }
        }
        if (fetched.length > 0) {
          // 2026-10-12 (zombie guard): a late-settling inner whose entry was already
          // released+regenerated must not clobber the newer attempt's cache rows.
          if (isCurrentEntry()) {
            await this.persistBars(symbol, timeframe, fetched, 'ibkr', startMs, endMs);
          } else {
            console.warn(`[HistoricalDataGateway] stale zombie persist skipped for ${symbol} (${timeframe}): entry regenerated after inner timeout.`);
          }
          // Stale-tail path: the IBKR bars must actually have moved the tail - verify
          // instead of assuming. Old bars returned by the provider are not relabeled fresh.
          if (staleTail) await this.verifyStaleTailMoved(symbol, timeframe, startMs, endMs);
          // 2026-10-12 (L2): a zombie inner (entry released + regenerated after the inner
          // timeout) must not reset the CURRENT attempt's 429 backoff - the fresh attempt
          // may have armed it while this stale inner was settling.
          else if (isCurrentEntry()) this.consecutiveRateLimits = 0;
          return;
        }
        // 2026-10-11 (stale-tail invariant): the IBKR-empty path must run the same
        // stale-tail check as every other fallback. Returning the cache here without
        // consulting staleTail re-admits the Oct-9 forensic condition (stale cache
        // served as fresh). With a stale tail, fall through to Alpaca; the
        // verifyStaleTailMoved at the bottom still throws DATA_STALE if nothing fresh
        // ever arrives.
        if (existing.length > 0 && !staleTail) return;
        // Real root cause (2026-09-10, missed-opportunity-evaluation forensic pass): confirmed
        // live that IBKR's historical-bar API returns empty for many real, liquid US symbols on
        // this account (same market-data-entitlement gap - code 354 "not subscribed" - already
        // observed on the live streaming path), which silently starved
        // MissedOpportunityEvaluator.evaluatePending() forever (every record stayed PENDING, 0/18
        // evaluated across a full session with real elapsed time to spare). Previously this threw
        // immediately with no fallback. Alpaca's REST bars endpoint is already a real, configured,
        // independent data source (same credentials MarketDataWorker's live tick stream already
        // uses) - falling through to it here, instead of failing closed immediately, is the same
        // "primary provider unavailable -> try a real, already-configured alternative before
        // giving up" pattern as this session's FundamentalAgent/MacroAgent AlphaVantage->FMP/FRED
        // fallback. Still never fabricates a bar - if Alpaca also has nothing, the existing
        // no-data throw below still fires.
        if (telCtx) telCtx.fellBack = true;
        console.warn(`[HistoricalDataGateway] IBKR historical bars empty for ${symbol} (${timeframe}) - falling back to Alpaca.`);
      } catch (e: any) {
        // Stale-tail path: never silently fall back to stale cached bars when the provider
        // failed - fall through to the next provider instead, and the DATA_STALE check at
        // the bottom still applies if nothing fresh ever arrives.
        if (existing.length > 0 && !staleTail) {
          console.warn(
            `[HistoricalDataGateway] IBKR hist failed for ${symbol} — using ${existing.length} cached bars: ${e?.message || e}`,
          );
          return;
        }
        if (telCtx) telCtx.fellBack = true;
        console.warn(`[HistoricalDataGateway] IBKR hist failed for ${symbol} (${timeframe}) - falling back to Alpaca: ${e?.message || e}`);
      }
    }

    if (Date.now() < this.rateLimitedUntilMs) {
      // Stale-tail path: a provider-side cooldown is not a provider-side success - surface
      // the rate limit honestly rather than quietly serving stale data as if it were fine.
      if (existing.length > 0 && !staleTail) return;
      throw new Error(
        `Alpaca bars request rate-limited until ${new Date(this.rateLimitedUntilMs).toISOString()} - failing closed, no fabricated bars.`,
      );
    }

    if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
      if (existing.length > 0 && !staleTail) return;
      throw new Error('Historical backfill requires ALPACA_API_KEY/ALPACA_SECRET_KEY - no other real historical data source is wired into Argus.');
    }

    const alpacaPaceT0 = performance.now();
    await this.paceAlpacaFetch();
    if (telCtx) { telCtx.provider = 'alpaca'; telCtx.alpacaQueueWaitMs = performance.now() - alpacaPaceT0; telCtx.alpacaServiceMs = 0; telCtx.barsReturned = 0; telCtx.validBars = 0; }

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

      // 2026-10-11 (#20): the pagination loop had NO timeout — a stalled connection
      // hangs forever and wedges the fast-lane/scheduler work it feeds. Use the
      // existing alpacaRequestTimeoutMs convention.
      // 2026-10-12 (M2): combine the per-page request timeout with the inner-timeout
      // AbortSignal so HISTORICAL_INNER_FETCH_TIMEOUT cancels this real HTTP request
      // instead of abandoning it as a zombie fetch.
      const pageTimeoutSignal = AbortSignal.timeout(tradingSafety.alpacaRequestTimeoutMs);
      const alpacaPageT0 = performance.now();
      const res = await fetch(url.toString(), {
        headers: {
          'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
          'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
        },
        signal: abortSignal ? AbortSignal.any([pageTimeoutSignal, abortSignal]) : pageTimeoutSignal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 429) {
          this.armBarsRateLimitBackoff(res.headers.get('Retry-After'));
          // Stale-tail path: the 429 cooldown is a provider failure, not a reason to
          // quietly keep serving the stale tail - surface it (callers already handle this
          // throw for the empty-cache case, so nothing new can break on it).
          if (existing.length > 0 && !staleTail) {
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
      if (telCtx) {
        telCtx.alpacaServiceMs = (telCtx.alpacaServiceMs ?? 0) + (performance.now() - alpacaPageT0);
        telCtx.barsReturned = (telCtx.barsReturned ?? 0) + bars.length;
        telCtx.validBars = (telCtx.validBars ?? 0) + bars.filter((b: any) => Number.isFinite(b?.c) && b.c > 0).length;
        if (bars.length > 0) {
          const lastTs = new Date(bars[bars.length - 1].t).getTime();
          if (Number.isFinite(lastTs)) telCtx.cacheLatestBarMs = Math.max(telCtx.cacheLatestBarMs ?? 0, lastTs);
          telCtx.cacheCoverage = (telCtx.validBars ?? 0) / expected;
        }
      }
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
        // 2026-10-12 (zombie guard): see IBKR path above.
        if (isCurrentEntry()) {
          await this.persistBars(symbol, timeframe, mapped, 'alpaca', startMs, endMs);
        } else {
          console.warn(`[HistoricalDataGateway] stale zombie persist skipped for ${symbol} (${timeframe}): entry regenerated after inner timeout.`);
        }
      }
      pageToken = data.next_page_token || undefined;
      if (pageToken) await this.paceAlpacaFetch();
    } while (pageToken);

    // 2026-10-12 (zombie guard): a stale inner must not wipe the fresh attempt's memory cache.
    if (isCurrentEntry()) {
      this.memoryBars.delete(this.memoryKey(symbol, timeframe, startMs, endMs));
    }

    // Stale-tail path: the provider refresh must have actually moved the tail. An empty
    // provider response leaves "missing" missing - no bar is fabricated - and the loud
    // DATA_STALE error below surfaces instead of a silent "sufficient" return.
    if (staleTail) {
      await this.verifyStaleTailMoved(symbol, timeframe, startMs, endMs);
      return;
    }

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

        // 2026-10-11 (#20): timeout for the pagination loop (see above).
        const res = await fetch(url.toString(), {
          headers: { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY },
          signal: AbortSignal.timeout(tradingSafety.alpacaRequestTimeoutMs),
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
    const hit = this.cacheGet(key);
    if (hit && hit.expiresAt > Date.now()) {
      // 2026-10-11 (#10): filter cached bars to the requested [startMs, endMs] on hit.
      // The cache entry may cover a wider range than this query (e.g. warmed by an
      // earlier wider query); returning it unfiltered would leak post-cutoff bars.
      return hit.bars.filter((b) => b.timestamp >= startMs && b.timestamp <= endMs);
    }
    // 2026-10-12 (D1): fetch the FULL hour-bucket range on miss, so the cached entry
    // covers any sub-range query within these buckets. The hit-path filter above
    // narrows to the requested [startMs, endMs].
    const bucketStartMs = Math.floor(startMs / 3_600_000) * 3_600_000;
    const bucketEndMs = (Math.floor(endMs / 3_600_000) + 1) * 3_600_000 - 1;
    const rows = await db.select().from(schema.ohlcvBars)
      .where(and(
        eq(schema.ohlcvBars.symbol, symbol),
        eq(schema.ohlcvBars.timeframe, timeframe),
        gte(schema.ohlcvBars.timestamp, bucketStartMs),
        lte(schema.ohlcvBars.timestamp, bucketEndMs)
      ))
      .orderBy(asc(schema.ohlcvBars.timestamp));
    const bars = dedupeDailyBarsBySession(
      timeframe,
      rows.map(r => ({ timestamp: r.timestamp, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume })),
    );
    this.cacheSet(key, { bars, expiresAt: Date.now() + 60_000 });
    // The cache holds the whole bucket, but the caller asked for [startMs, endMs]: returning the
    // bucket here would hand a cold query bars AFTER its cutoff (lookahead) and make the result
    // depend on whether the cache was warm. Both paths must return the identical exact slice.
    return bars.filter((b) => b.timestamp >= startMs && b.timestamp <= endMs);
  }
}

export const historicalDataGateway = HistoricalDataGateway.getInstance();
