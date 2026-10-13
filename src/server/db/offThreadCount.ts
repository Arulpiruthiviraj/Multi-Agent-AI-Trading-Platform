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
const pending = new Map<number, { resolve: (v: number | null) => void; timer: ReturnType<typeof setTimeout> }>();

function ensureWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { dbPath, cwd: process.cwd() } });
    worker.unref();
    worker.on('message', (m: { id: number; value?: number; error?: string }) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) console.warn('[offThreadCount] query failed:', m.error);
      p.resolve(m.error ? null : (m.value ?? null));
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

export function stopOffThreadCountWorker(): void {
  const w = worker;
  worker = null;
  if (w) void w.terminate();
}
