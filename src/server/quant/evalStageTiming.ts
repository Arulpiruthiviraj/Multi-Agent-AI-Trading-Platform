/**
 * 2026-10-12 (Oct-12 live forensic): per-stage wall-clock timing and a bounded error code for
 * QuantSignalAgent.evaluateSymbol(). Observability only - never gates, retries, or alters an
 * evaluation. Born from a live finding: median 308 s between the primary-bar event and the
 * FINISHED event, 314 ERROR outcomes, and no persisted evidence of WHICH awaited stage or WHICH
 * error accounted for it.
 */

export interface QuantEvalStageTimer {
  /** Closes the stage that was running since the previous mark (or construction) under `stage`. */
  mark(stage: string): void;
  /** Milliseconds per CLOSED stage, in order. A repeated stage name accumulates. */
  stageMs(): Record<string, number>;
  /** The stage that was still running (never closed) - set on an error/abort exit. */
  openStageAfter(): string | null;
  /** Wall-clock ms since construction. */
  totalMs(): number;
}

export function createQuantEvalStageTimer(now: () => number = Date.now): QuantEvalStageTimer {
  const startedAt = now();
  let last = startedAt;
  let lastClosed: string | null = null;
  const out: Record<string, number> = {};
  return {
    mark(stage: string): void {
      const t = now();
      out[stage] = (out[stage] ?? 0) + Math.max(0, t - last);
      last = t;
      lastClosed = stage;
    },
    stageMs: () => ({ ...out }),
    openStageAfter: () => lastClosed,
    totalMs: () => Math.max(0, now() - startedAt),
  };
}

export type QuantEvalErrorCode =
  | 'COALESCE_CALLER_TIMEOUT'
  | 'IBKR_HISTORICAL_TIMEOUT'
  | 'IBKR_HISTORICAL_ERROR'
  | 'IBKR_NOT_CONNECTED'
  | 'DATA_STALE'
  | 'RATE_LIMITED'
  | 'PROVIDER_CREDENTIALS_MISSING'
  | 'DB_NOT_OPEN'
  | 'PROVIDER_HTTP_ERROR'
  | 'NO_BARS_AVAILABLE'
  | 'UNKNOWN_ERROR';

/**
 * Maps a thrown value to a BOUNDED, sanitized code. Never returns message text, so no provider
 * response body, URL, or credential fragment can reach an observability row.
 */
export function classifyQuantEvalError(e: unknown): QuantEvalErrorCode {
  const msg = String((e as { message?: unknown } | null)?.message ?? e ?? '');
  if (/COALESCE_CALLER_TIMEOUT/.test(msg)) return 'COALESCE_CALLER_TIMEOUT';
  if (/IBKR historicalData timeout/i.test(msg)) return 'IBKR_HISTORICAL_TIMEOUT';
  if (/IBKR historicalData error|IBKR historical-data rejection/i.test(msg)) return 'IBKR_HISTORICAL_ERROR';
  if (/IBKR socket session is not connected/i.test(msg)) return 'IBKR_NOT_CONNECTED';
  if (/DATA_STALE/.test(msg)) return 'DATA_STALE';
  if (/429|rate-limited|Too Many Requests/i.test(msg)) return 'RATE_LIMITED';
  if (/requires ALPACA_API_KEY/i.test(msg)) return 'PROVIDER_CREDENTIALS_MISSING';
  if (/database connection is not open/i.test(msg)) return 'DB_NOT_OPEN';
  if (/Alpaca bars request failed|bars request.*(failed|HTTP)|HTTP \d{3}/i.test(msg)) return 'PROVIDER_HTTP_ERROR';
  if (/no (real )?bars|no data/i.test(msg)) return 'NO_BARS_AVAILABLE';
  return 'UNKNOWN_ERROR';
}
