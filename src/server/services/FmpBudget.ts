/**
 * Shared Financial Modeling Prep daily HTTP budget.
 *
 * Real root cause (2026-09-10, "why did Argus miss this morning's movers" investigation): the
 * live DB showed FundamentalAgent hitting AlphaVantage's real 25-req/day free-tier cap and
 * emitting a DATA_UNAVAILABLE HOLD 228 times in one session. FMP's free tier (250 req/day) is
 * used here ONLY as a fallback when AlphaVantage itself is exhausted/rate-limited for the day -
 * this never becomes the primary fundamentals source, and never competes with
 * AlphaVantageBudget's own accounting. Mirrors AlphaVantageBudget.ts's shared-lock pattern
 * (persisted in ExternalDataCache so a restart does not reset the day's spend); no reserved-slot
 * carve-out is needed since FundamentalAgent is the only real caller.
 */
import { ExternalDataCache } from './ExternalDataCache';
import { tradingSafety } from '../config/tradingSafety';

type BudgetPayload = { utcDate: string; used: number };

function utcDateKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

let chain: Promise<unknown> = Promise.resolve();

function withLockTimeout<T>(fn: () => Promise<T>, ms: number): () => Promise<T> {
  return () => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`FmpBudget: enqueued operation exceeded ${ms}ms - releasing shared lock`));
    }, ms);
    fn().then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const guarded = withLockTimeout(fn, tradingSafety.fmpBudgetLockTimeoutMs);
  const run = chain.then(guarded, guarded);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

export class FmpBudget {
  static async tryConsume(count: number = 1, nowMs: number = Date.now()): Promise<boolean> {
    if (count <= 0) return true;
    return enqueue(async () => {
      const budget = tradingSafety.fmpDailyRequestBudget;
      const utcDate = utcDateKey(nowMs);
      const row = await ExternalDataCache.getStale<BudgetPayload>('fmp', 'daily-budget', null);
      const used = row && row.utcDate === utcDate && Number.isFinite(row.used) ? row.used : 0;
      if (used + count > budget) return false;
      await ExternalDataCache.set('fmp', 'daily-budget', null, { utcDate, used: used + count });
      return true;
    });
  }

  static async remaining(nowMs: number = Date.now()): Promise<number> {
    const budget = tradingSafety.fmpDailyRequestBudget;
    const utcDate = utcDateKey(nowMs);
    const row = await ExternalDataCache.getStale<BudgetPayload>('fmp', 'daily-budget', null);
    const used = row && row.utcDate === utcDate && Number.isFinite(row.used) ? row.used : 0;
    return Math.max(0, budget - used);
  }

  /** Test helper. */
  static async resetForTests(): Promise<void> {
    await ExternalDataCache.set('fmp', 'daily-budget', null, { utcDate: '', used: 0 });
  }
}
