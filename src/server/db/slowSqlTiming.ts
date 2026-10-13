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
export interface SlowSqlRecord {
  atMs: number; durationMs: number; method: string; sql: string;
  /** Stable grouping key computed from the FULL statement (before the 400-char truncation): `<verb> <table> #<hash>`. */
  signature: string;
  table: string | null;
  /** First application stack frames (file:line) that issued the statement - slow statements only. */
  callerFrames: string[];
}

/**
 * 2026-10-13: the stored `sql` is truncated at 400 chars, so a wide select-list (the full-row trades select) hid its
 * own FROM clause and was mis-grouped as OTHER in the Oct 13 audit. Grouping must use this signature, derived from
 * the full text, never a substring of the truncated copy.
 */
export function sqlSignature(source: string): { signature: string; table: string | null; verb: string } {
  const text = String(source).replace(/\s+/g, ' ').trim();
  const verb = (/^\s*(with|select|insert|update|delete|replace|pragma|create|drop|alter)/i.exec(text)?.[1] ?? 'other').toLowerCase();
  const tableMatch = verb === 'insert' || verb === 'replace'
    ? /\binto\s+["`]?([A-Za-z0-9_]+)["`]?/i.exec(text)
    : verb === 'update'
      ? /^update\s+["`]?([A-Za-z0-9_]+)["`]?/i.exec(text)
      : /\bfrom\s+["`]?([A-Za-z0-9_]+)["`]?/i.exec(text);
  const table = tableMatch?.[1] ?? null;
  // Parameter-free structural hash: strip literals and collapse IN-lists/placeholder runs so the same query shape groups together.
  const shape = text.replace(/'(?:[^']|'')*'/g, "'?'").replace(/\b\d+(?:\.\d+)?\b/g, '?').replace(/(?:\?\s*,\s*)+\?/g, '?');
  let h = 5381;
  for (let i = 0; i < shape.length; i++) h = ((h << 5) + h + shape.charCodeAt(i)) | 0;
  return { signature: `${verb} ${table ?? '?'} #${(h >>> 0).toString(16).padStart(8, '0')}`, table, verb };
}

/** Application frames only (drops node internals, node_modules and this file). Bounded; never throws. */
function callerFramesFromStack(stack: string | undefined): string[] {
  try {
    return String(stack ?? '').split('\n').slice(1)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('at ') && !/node_modules|node:internal|slowSqlTiming.ts/.test(l))
      .slice(0, 4)
      .map((l) => l.replace(/^at /, '').replace(/\(?[A-Za-z]:[\\/].*?[\\/](src[\\/][^)]*)\)?$/, '$1').slice(0, 160));
  } catch { return []; }
}

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
    const sig = sqlSignature(source);
    const rec: SlowSqlRecord = {
      atMs: Date.now(), durationMs: Math.round(ms), method, sql: source.replace(/\s+/g, ' ').slice(0, 400),
      signature: sig.signature, table: sig.table, callerFrames: callerFramesFromStack(new Error().stack),
    };
    ring.push(rec);
    if (ring.length > RING_MAX) ring.shift();
    console.warn(`[SLOW_SQL] ${rec.durationMs}ms ${method}: ${rec.sql}`);
    void import('../observability/StructuredLogger').then(({ observeSafe, structuredLogger }) =>
      observeSafe(() => structuredLogger.warn('slow_sql_statement', {
        category: 'SYSTEM', eventType: 'SLOW_SQL_STATEMENT', durationMs: rec.durationMs, method, sql: rec.sql,
        signature: rec.signature, table: rec.table, callerFrames: rec.callerFrames,
        reasoning: `A synchronous SQLite ${method} blocked the event loop for ${rec.durationMs}ms.`,
      }), 'slowSqlTiming')).catch(() => undefined);
  } catch { /* instrumentation must never throw */ }
}
