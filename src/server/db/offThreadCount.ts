/**
 * offThreadCount.ts - run a read-only COUNT off the trading-critical event loop (2026-10-12).
 *
 * The evaluators' "true backlog size" statistics (`select count(*) ... left join ... where pending`) are
 * correctness-audited observability numbers that must stay exact, but on the 17 GB production database each one
 * is a 5-9 s SYNCHRONOUS better-sqlite3 call (SLOW_SQL_STATEMENT) when run on the main thread, every cycle. This
 * runs the identical SQL on a persistent worker thread with its own READ-ONLY connection, so the main thread
 * keeps serving the event loop (health, PortfolioMonitor, EventBus) while the count is computed.
 *
 * Contract: never throws; resolves `null` if the worker is unavailable, the query errors, or it exceeds the
 * deadline (callers keep the previous value / mark the statistic incomplete). The worker holds no write handle,
 * cannot place orders, and is terminated on shutdown. Only a single COUNT-style statement is accepted.
 */
import { Worker } from 'node:worker_threads';
import { dbPath } from './index';

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { createRequire } = require('node:module');
const path = require('node:path');
const Database = createRequire(path.join(workerData.cwd, 'package.json'))('better-sqlite3');
let db = null;
function open() { if (!db) db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true }); return db; }
setInterval(() => {}, 60000); // keep alive
parentPort.on('message', (m) => {
  try {
    if (m.kind === 'rows') {
      parentPort.postMessage({ id: m.id, rows: open().prepare(m.sql).raw(true).all(...m.params) });
      return;
    }
    const row = open().prepare(m.sql).raw(false).get(...m.params);
    const v = row ? Object.values(row)[0] : 0;
    parentPort.postMessage({ id: m.id, value: Number(v) });
  } catch (e) {
    parentPort.postMessage({ id: m.id, error: String(e && e.message || e) });
  }
});
`;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; timer: ReturnType<typeof setTimeout> }>();

function ensureWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { dbPath, cwd: process.cwd() } });
    worker.unref();
    worker.on('message', (m: { id: number; value?: number; rows?: unknown[][]; error?: string }) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) console.warn('[offThreadCount] query failed:', m.error);
      p.resolve(m.error ? null : (m.rows !== undefined ? m.rows : (m.value ?? null)));
    });
    const fail = () => {
      for (const [id, p] of pending) { clearTimeout(p.timer); p.resolve(null); pending.delete(id); }
      worker = null;
    };
    worker.on('error', fail);
    worker.on('exit', fail);
  } catch (e) {
    console.warn('[offThreadCount] worker unavailable:', e instanceof Error ? e.message : String(e));
    worker = null;
  }
  return worker;
}

/** `builder` is any drizzle query exposing toSQL() (SELECT count(*) ...). Resolves null on any failure. */
export function countOffThread(
  builder: { toSQL(): { sql: string; params: unknown[] } },
  timeoutMs = 120_000,
): Promise<number | null> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(null);
  const { sql, params } = builder.toSQL();
  if (!/^\s*select\s+count\(\*\)/i.test(sql)) return Promise.resolve(null); // read-only counts only
  return new Promise<number | null>((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, timeoutMs);
    pending.set(id, { resolve, timer });
    try { w.postMessage({ id, sql, params }); } catch { pending.delete(id); clearTimeout(timer); resolve(null); }
  });
}

/**
 * 2026-10-13: run a read-only SELECT that returns ROWS off the trading-critical event loop. The Oct 13 repaired build still
 * showed single synchronous research queries blocking the main thread for 34-48 s (the evaluators' pending-page selects over
 * the 17-19 GB prediction tables): far beyond any PortfolioMonitor safety bound. The identical SQL runs on the read-only
 * worker; rows come back as positional arrays and are decoded with each drizzle column's own mapFromDriverValue, so callers
 * receive exactly the objects the main-thread query returned. Resolves null on worker failure / error / deadline - callers
 * treat that as "no work this cycle" and must NEVER fall back to the main-thread query.
 * `columns` is a flat drizzle column map and MUST be exactly the select list of `builder`, in the same order.
 */
export async function selectRowsOffThread<C extends Record<string, { mapFromDriverValue?: (v: unknown) => unknown }>>(
  builder: { toSQL(): { sql: string; params: unknown[] } },
  columns: C,
  timeoutMs = 120_000,
): Promise<Array<{ [K in keyof C]: any }> | null> {
  const w = ensureWorker();
  if (!w) return null;
  const { sql, params } = builder.toSQL();
  if (!/^\s*select\b/i.test(sql)) return null; // read-only SELECTs only
  const keys = Object.keys(columns);
  const raw = await new Promise<unknown[][] | null>((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, timeoutMs);
    pending.set(id, { resolve, timer });
    try { w.postMessage({ id, sql, params, kind: 'rows' }); } catch { pending.delete(id); clearTimeout(timer); resolve(null); }
  });
  if (!raw) return null;
  return raw.map((arr) => {
    const row: Record<string, unknown> = {};
    keys.forEach((k, i) => {
      const v = arr[i];
      const col = columns[k];
      row[k] = v !== null && v !== undefined && typeof col.mapFromDriverValue === 'function' ? col.mapFromDriverValue(v) : v;
    });
    return row as { [K in keyof C]: any };
  });
}

export function stopOffThreadCountWorker(): void {
  const w = worker;
  worker = null;
  if (w) void w.terminate();
}
