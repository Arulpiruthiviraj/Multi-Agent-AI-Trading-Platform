/**
 * dbCallerContext - names WHICH workload issued a SQLite statement (2026-10-13).
 *
 * The Oct 13 audit could say a full-row `trades` SELECT blocked the event loop for tens of seconds but could not say who issued it:
 * drizzle/better-sqlite3 calls lose their JS stack across awaits, so `callerFrames` was empty for the async ones. An AsyncLocalStorage label
 * set at the entry of each periodic cycle / HTTP request survives awaits and is read synchronously when a slow statement is recorded.
 * Pure observability: it never alters a query, a result or timing beyond an ALS lookup on the (already slow) recording path.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage<string>();

/** Runs `fn` with `label` as the DB caller. Nested labels join with ">" so the outermost workload stays visible. */
export function runWithDbCaller<T>(label: string, fn: () => T): T {
  const outer = als.getStore();
  return als.run(outer ? `${outer}>${label}`.slice(0, 160) : label, fn);
}

export function currentDbCaller(): string | null {
  return als.getStore() ?? null;
}
