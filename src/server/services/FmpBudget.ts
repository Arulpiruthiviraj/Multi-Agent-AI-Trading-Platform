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

// 2026-10-12 (M4): caller release is decoupled from chain advancement. On lock-timeout
// the CALLER's promise rejects immediately (loud per-cycle error, as before), but the
// internal `chain` advances only when the UNDERLYING fn()'s real promise settles (resolve
// or reject). Advancing the chain on the caller's timeout rejection let the NEXT enqueued
// operation's read-modify-write run concurrently with this one's still-running write - a
// lost-update race on the persisted budget counter (two writers read the same `used`,
// both write `used + count`, one increment is silently lost). Serializing on real
// settlement means the counter reflects actual fn() outcomes only. Tradeoff, stated
// plainly: an fn() that NEVER settles now holds the chain (the 2026-08-18 starvation
// mode) instead of being skipped past - but the timed-out caller still gets its loud
// error, and no counter write is ever silently lost to concurrency.
function withLockTimeout<T>(fn: () => Promise<T>, ms: number): { guarded: () => Promise<T>; settled: Promise<void> } {
  let resolveSettled!: () => void;
  const settled = new Promise<void>((res) => { resolveSettled = res; });
  const guarded = () => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Caller release: reject NOW. `settled` still only resolves when fn()'s real
      // promise settles below, so the chain cannot advance past a still-running write.
      reject(new Error(`FmpBudget: enqueued operation exceeded ${ms}ms - releasing shared lock`));
    }, ms);
    let underlying: Promise<T>;
    try {
      underlying = fn();
    } catch (e) {
      clearTimeout(timer);
      resolveSettled();
      reject(e);
      return;
    }
    underlying.then(
      (v) => { clearTimeout(timer); resolveSettled(); resolve(v); },
      (e) => { clearTimeout(timer); resolveSettled(); reject(e); },
    );
  });
  return { guarded, settled };
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const { guarded, settled } = withLockTimeout(fn, tradingSafety.fmpBudgetLockTimeoutMs);
  const run = chain.then(guarded, guarded);
  chain = settled.then(() => undefined, () => undefined);
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
