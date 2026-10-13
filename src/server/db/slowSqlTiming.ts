/**
 * slowSqlTiming.ts - names the SQL behind a synchronous main-thread block (2026-10-12).
 *
 * The freeze profiler showed ~300 s spent inside a single better-sqlite3 `.all()` but a profile only
 * identifies the native call, not the statement. This wraps `prepare()` so any statement execution
 * (all/get/run/values/iterate-start) that blocks longer than the threshold is recorded with a truncated,
 * parameter-free SQL string. Fail-open: never throws, never alters results, adds two clock reads per call.
 * Output: console.warn + a bounded in-memory ring (read by getRecentSlowSql()); the structured logger is
 * loaded lazily to avoid an import cycle with the observability store (which persists via this same handle).
 */
export interface SlowSqlRecord { atMs: number; durationMs: number; method: string; sql: string }

const RING_MAX = 50;
const ring: SlowSqlRecord[] = [];
export function getRecentSlowSql(): SlowSqlRecord[] { return [...ring]; }

export function instrumentSlowSql(sqlite: any, thresholdMs: number): void {
  if (!sqlite || typeof sqlite.prepare !== 'function' || (sqlite as any).__slowSqlInstrumented) return;
  (sqlite as any).__slowSqlInstrumented = true;
  const origPrepare = sqlite.prepare.bind(sqlite);
  sqlite.prepare = (source: string, ...rest: any[]) => {
    const stmt = origPrepare(source, ...rest);
    for (const method of ['all', 'get', 'run', 'values'] as const) {
      const orig = (stmt as any)[method];
      if (typeof orig !== 'function') continue;
      (stmt as any)[method] = function (...args: any[]) {
        const t0 = performance.now();
        try {
          return orig.apply(this, args);
        } finally {
          const ms = performance.now() - t0;
          if (ms >= thresholdMs) record(method, String(source), ms);
        }
      };
    }
    return stmt;
  };
}

function record(method: string, source: string, ms: number): void {
  try {
    const rec: SlowSqlRecord = { atMs: Date.now(), durationMs: Math.round(ms), method, sql: source.replace(/\s+/g, ' ').slice(0, 400) };
    ring.push(rec);
    if (ring.length > RING_MAX) ring.shift();
    console.warn(`[SLOW_SQL] ${rec.durationMs}ms ${method}: ${rec.sql}`);
    void import('../observability/StructuredLogger').then(({ observeSafe, structuredLogger }) =>
      observeSafe(() => structuredLogger.warn('slow_sql_statement', {
        category: 'SYSTEM', eventType: 'SLOW_SQL_STATEMENT', durationMs: rec.durationMs, method, sql: rec.sql,
        reasoning: `A synchronous SQLite ${method} blocked the event loop for ${rec.durationMs}ms.`,
      }), 'slowSqlTiming')).catch(() => undefined);
  } catch { /* instrumentation must never throw */ }
}
