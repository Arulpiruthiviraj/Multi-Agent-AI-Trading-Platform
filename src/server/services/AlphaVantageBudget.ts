/**
 * Shared AlphaVantage daily HTTP budget (DEF-13).
 *
 * Fund + Macro previously each fetched independently (Macro 3 parallel calls per cache miss).
 * Free-tier quota is 25 req/day — a global counter, persisted in ExternalDataCache so a restart
 * does not reset the day's spend. Never fabricates payloads: callers serve stale cache or
 * RATE_LIMITED when tryConsume() returns false.
 */
import { ExternalDataCache } from './ExternalDataCache';
import { tradingSafety } from '../config/tradingSafety';

type BudgetPayload = { utcDate: string; used: number };

function utcDateKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

export class AlphaVantageBudget {
  static async tryConsume(count: number = 1, nowMs: number = Date.now()): Promise<boolean> {
    if (count <= 0) return true;
    return enqueue(async () => {
      const budget = tradingSafety.alphaVantageDailyRequestBudget;
      const utcDate = utcDateKey(nowMs);
      const row = await ExternalDataCache.getStale<BudgetPayload>('alphavantage', 'daily-budget', null);
      const used = row && row.utcDate === utcDate && Number.isFinite(row.used) ? row.used : 0;
      if (used + count > budget) return false;
      await ExternalDataCache.set('alphavantage', 'daily-budget', null, { utcDate, used: used + count });
      return true;
    });
  }

  static async remaining(nowMs: number = Date.now()): Promise<number> {
    const budget = tradingSafety.alphaVantageDailyRequestBudget;
    const utcDate = utcDateKey(nowMs);
    const row = await ExternalDataCache.getStale<BudgetPayload>('alphavantage', 'daily-budget', null);
    const used = row && row.utcDate === utcDate && Number.isFinite(row.used) ? row.used : 0;
    return Math.max(0, budget - used);
  }

  /** Test helper — does not wipe other AV cache rows. */
  static async resetForTests(): Promise<void> {
    await ExternalDataCache.set('alphavantage', 'daily-budget', null, { utcDate: '', used: 0 });
  }
}
