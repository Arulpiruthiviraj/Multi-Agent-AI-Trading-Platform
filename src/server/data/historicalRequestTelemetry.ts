/**
 * historicalRequestTelemetry.ts - per-request attribution for historical-bar requests and a bounded
 * intraday availability registry (2026-10-13).
 *
 * Why: on Oct 13, 97% of post-open Quant evaluations ran into the 8 s intraday deadline and nothing stored could
 * say where the time went (cache, coalescing, IBKR serial historical queue, provider service time, Alpaca pacing).
 * Every historical request now carries a context (AsyncLocalStorage) that the gateway and the IBKR session fill in;
 * at the terminal point it is persisted - asynchronously, in small INSERT/UPSERT batches (no scans) - to
 * `historical_request_telemetry`, and the symbol/provider/timeframe/session availability row is upserted.
 *
 * Contract: fail-open. Telemetry can never throw into, delay, or change a data request; if the queue is full the
 * oldest records are dropped and counted. Nothing here fabricates a bar or relabels a timeout as "no setup".
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type AvailabilityStatus =
  | 'AVAILABLE_FRESH'
  | 'AVAILABLE_DELAYED'
  | 'PARTIAL'
  | 'STALE'
  | 'TIMED_OUT'
  | 'UNAVAILABLE'
  | 'UNKNOWN';

export type RequestRole = 'OWNER' | 'COALESCED' | 'CACHE_ONLY' | 'CALLER_DEADLINE';

export interface HistRequestContext {
  requestId: string;
  traceId: string | null;
  symbol: string;
  timeframe: string;
  startMs: number;
  endMs: number;
  asOfMs: number;
  role: RequestRole;
  t0: number; // performance.now() at creation
  provider: string; // 'cache' | 'ibkr' | 'alpaca' | 'none'
  cacheHit: boolean;
  cacheBarCount: number | null;
  cacheLatestBarMs: number | null;
  cacheCoverage: number | null;
  cacheNormalizationMs: number | null;
  ibkrQueueWaitMs: number | null;
  ibkrServiceMs: number | null;
  alpacaQueueWaitMs: number | null;
  alpacaServiceMs: number | null;
  coalesceWaitMs: number | null;
  barsReturned: number | null;
  validBars: number | null;
  fellBack: boolean;
  expectedBars: number | null;
}

export interface FinalizeInput {
  terminalStatus: string; // OK | CACHE_HIT | HISTORICAL_INNER_FETCH_TIMEOUT | COALESCE_CALLER_TIMEOUT | CALLER_DEADLINE | DATA_STALE | NO_DATA | ERROR
  reason?: string | null;
}

export const histRequestStore = new AsyncLocalStorage<HistRequestContext>();

export function newHistRequestContext(args: {
  symbol: string; timeframe: string; startMs: number; endMs: number; role?: RequestRole; traceId?: string | null; expectedBars?: number | null;
}): HistRequestContext {
  return {
    requestId: randomUUID(),
    traceId: args.traceId ?? null,
    symbol: args.symbol,
    timeframe: args.timeframe,
    startMs: args.startMs,
    endMs: args.endMs,
    asOfMs: Date.now(),
    role: args.role ?? 'OWNER',
    t0: performance.now(),
    provider: 'none',
    cacheHit: false,
    cacheBarCount: null,
    cacheLatestBarMs: null,
    cacheCoverage: null,
    cacheNormalizationMs: null,
    ibkrQueueWaitMs: null,
    ibkrServiceMs: null,
    alpacaQueueWaitMs: null,
    alpacaServiceMs: null,
    coalesceWaitMs: null,
    barsReturned: null,
    validBars: null,
    fellBack: false,
    expectedBars: args.expectedBars ?? null,
  };
}

export interface ClassifyInput {
  terminalStatus: string;
  latestBarMs: number | null;
  asOfMs: number;
  coverage: number | null;
  freshnessToleranceMs: number;
  delayedMaxMs: number;
  minCoverage: number;
}

/** Pure mapping from a terminal outcome plus the actual latest bar to an availability status. */
export function classifyAvailability(i: ClassifyInput): AvailabilityStatus {
  const s = i.terminalStatus;
  if (s === 'HISTORICAL_INNER_FETCH_TIMEOUT' || s === 'COALESCE_CALLER_TIMEOUT' || s === 'CALLER_DEADLINE') return 'TIMED_OUT';
  if (s === 'DATA_STALE') return 'STALE';
  if (s === 'NO_DATA' || s === 'ERROR') return i.latestBarMs === null ? 'UNAVAILABLE' : 'STALE';
  if (s === 'OK' || s === 'CACHE_HIT') {
    if (i.latestBarMs === null) return 'UNKNOWN';
    if (i.coverage !== null && i.coverage < i.minCoverage) return 'PARTIAL';
    const lag = i.asOfMs - i.latestBarMs;
    if (lag <= i.freshnessToleranceMs) return 'AVAILABLE_FRESH';
    if (lag <= i.delayedMaxMs) return 'AVAILABLE_DELAYED';
    return 'STALE';
  }
  return 'UNKNOWN';
}

interface QueuedRow { telemetry: Record<string, unknown>; availability: Record<string, unknown> | null }

const MAX_QUEUE = 5000;
const FLUSH_MS = 2000;
const BATCH = 200;
const queue: QueuedRow[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let dropped = 0;
let flushedRows = 0;
let flushFailures = 0;

export function telemetryStats(): { queued: number; dropped: number; flushedRows: number; flushFailures: number } {
  return { queued: queue.length, dropped, flushedRows, flushFailures };
}

function sessionDateNy(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

let epoch = `epoch_${Date.now().toString(36)}`;
export function setTelemetryProcessEpoch(e: string): void { epoch = e; }

function buildSha(): string | null {
  return (process.env.ARGUS_BUILD_SHA ?? '').trim() || null;
}

export function finalizeHistRequest(
  ctx: HistRequestContext,
  fin: FinalizeInput,
  thresholds: { freshnessToleranceMs: number; delayedMaxMs: number; minCoverage: number },
): AvailabilityStatus {
  let status: AvailabilityStatus = 'UNKNOWN';
  try {
    const totalMs = performance.now() - ctx.t0;
    status = classifyAvailability({
      terminalStatus: fin.terminalStatus,
      latestBarMs: ctx.cacheLatestBarMs,
      asOfMs: ctx.asOfMs,
      coverage: ctx.cacheCoverage,
      freshnessToleranceMs: thresholds.freshnessToleranceMs,
      delayedMaxMs: thresholds.delayedMaxMs,
      minCoverage: thresholds.minCoverage,
    });
    const nowIso = new Date().toISOString();
    const reason = fin.reason ? String(fin.reason).replace(/\s+/g, ' ').slice(0, 300) : null;
    const telemetry = {
      request_id: ctx.requestId, trace_id: ctx.traceId, symbol: ctx.symbol, provider: ctx.provider, timeframe: ctx.timeframe,
      window_start_ms: ctx.startMs, window_end_ms: ctx.endMs, as_of_ms: ctx.asOfMs, role: ctx.role,
      cache_hit: ctx.cacheHit ? 1 : 0, cache_bar_count: ctx.cacheBarCount, cache_latest_bar_ms: ctx.cacheLatestBarMs, cache_coverage: ctx.cacheCoverage,
      ibkr_queue_wait_ms: ctx.ibkrQueueWaitMs, ibkr_service_ms: ctx.ibkrServiceMs,
      alpaca_queue_wait_ms: ctx.alpacaQueueWaitMs, alpaca_service_ms: ctx.alpacaServiceMs,
      coalesce_wait_ms: ctx.coalesceWaitMs, cache_normalization_ms: ctx.cacheNormalizationMs,
      total_ms: totalMs, bars_returned: ctx.barsReturned, valid_bars: ctx.validBars,
      terminal_status: fin.terminalStatus, reason, fell_back: ctx.fellBack ? 1 : 0,
      process_epoch: epoch, build_sha: buildSha(), created_at: nowIso,
    };
    const ok = status === 'AVAILABLE_FRESH' || status === 'AVAILABLE_DELAYED' || status === 'PARTIAL';
    const skipAvailability = ctx.role === 'COALESCED' || fin.terminalStatus === 'LATE_SETTLEMENT';
    const availability = skipAvailability ? null : {
      symbol: ctx.symbol, provider: ctx.provider === 'none' || ctx.provider === 'cache' ? 'cache' : ctx.provider, timeframe: ctx.timeframe,
      session_date: sessionDateNy(ctx.asOfMs), status, last_bar_ms: ctx.cacheLatestBarMs, bar_count: ctx.validBars ?? ctx.cacheBarCount,
      expected_bar_count: ctx.expectedBars, coverage: ctx.cacheCoverage, last_checked_ms: ctx.asOfMs,
      last_success_ms: ok ? ctx.asOfMs : null, last_failure_ms: ok ? null : ctx.asOfMs, failed: ok ? 0 : 1,
      last_reason: reason, last_request_total_ms: totalMs, build_sha: buildSha(), updated_at: nowIso,
    };
    if (queue.length >= MAX_QUEUE) { queue.shift(); dropped += 1; }
    queue.push({ telemetry, availability });
    schedule();
  } catch {
    /* fail-open */
  }
  return status;
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; void flush(); }, FLUSH_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
}

async function flush(): Promise<void> {
  try {
    const { sqliteDb } = await import('../db');
    while (queue.length > 0) {
      const batch = queue.splice(0, BATCH);
      try {
        const insTel = sqliteDb.prepare(
          `INSERT INTO historical_request_telemetry (request_id,trace_id,symbol,provider,timeframe,window_start_ms,window_end_ms,as_of_ms,role,cache_hit,cache_bar_count,cache_latest_bar_ms,cache_coverage,ibkr_queue_wait_ms,ibkr_service_ms,alpaca_queue_wait_ms,alpaca_service_ms,coalesce_wait_ms,cache_normalization_ms,total_ms,bars_returned,valid_bars,terminal_status,reason,fell_back,process_epoch,build_sha,created_at)
           VALUES (@request_id,@trace_id,@symbol,@provider,@timeframe,@window_start_ms,@window_end_ms,@as_of_ms,@role,@cache_hit,@cache_bar_count,@cache_latest_bar_ms,@cache_coverage,@ibkr_queue_wait_ms,@ibkr_service_ms,@alpaca_queue_wait_ms,@alpaca_service_ms,@coalesce_wait_ms,@cache_normalization_ms,@total_ms,@bars_returned,@valid_bars,@terminal_status,@reason,@fell_back,@process_epoch,@build_sha,@created_at)`,
        );
        const upAvail = sqliteDb.prepare(
          `INSERT INTO intraday_data_availability (symbol,provider,timeframe,session_date,status,last_bar_ms,bar_count,expected_bar_count,coverage,last_checked_ms,last_success_ms,last_failure_ms,consecutive_failures,last_reason,last_request_total_ms,build_sha,updated_at)
           VALUES (@symbol,@provider,@timeframe,@session_date,@status,@last_bar_ms,@bar_count,@expected_bar_count,@coverage,@last_checked_ms,@last_success_ms,@last_failure_ms,@failed,@last_reason,@last_request_total_ms,@build_sha,@updated_at)
           ON CONFLICT(symbol,provider,timeframe,session_date) DO UPDATE SET
             status=excluded.status, last_bar_ms=COALESCE(excluded.last_bar_ms,last_bar_ms), bar_count=COALESCE(excluded.bar_count,bar_count),
             expected_bar_count=COALESCE(excluded.expected_bar_count,expected_bar_count), coverage=COALESCE(excluded.coverage,coverage),
             last_checked_ms=excluded.last_checked_ms, last_success_ms=COALESCE(excluded.last_success_ms,last_success_ms),
             last_failure_ms=COALESCE(excluded.last_failure_ms,last_failure_ms),
             consecutive_failures=CASE WHEN excluded.consecutive_failures=0 THEN 0 ELSE consecutive_failures+1 END,
             last_reason=excluded.last_reason, last_request_total_ms=excluded.last_request_total_ms, build_sha=excluded.build_sha, updated_at=excluded.updated_at`,
        );
        sqliteDb.transaction((rows: QueuedRow[]) => {
          for (const r of rows) {
            insTel.run(r.telemetry);
            if (r.availability) upAvail.run(r.availability);
          }
        })(batch);
        flushedRows += batch.length;
      } catch {
        flushFailures += 1; // drop the batch: telemetry must never accumulate unboundedly or block data requests
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } catch {
    flushFailures += 1;
  }
}

/** Test hook: flush now. */
export async function flushHistTelemetryForTests(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  await flush();
}
