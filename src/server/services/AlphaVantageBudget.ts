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

// 2026-08-18 forensic finding: this chain is the one piece of state FundamentalAgent and
// MacroAgent's setInterval loops actually share. If a single enqueued `fn` ever hangs (never
// resolves or rejects - a stuck SQLite call, a dangling fetch), every future tryConsume() call
// from either agent queues forever behind it with zero error/log output, which looks exactly
// like both agents' timers silently dying at once. Racing each `fn` against a hard timeout
// guarantees `chain` always settles, so a hang degrades to a loud per-cycle error instead of
// permanent, silent starvation of both agents.
function withLockTimeout<T>(fn: () => Promise<T>, ms: number): () => Promise<T> {
  return () => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`AlphaVantageBudget: enqueued operation exceeded ${ms}ms - releasing shared lock`));
    }, ms);
    fn().then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const guarded = withLockTimeout(fn, tradingSafety.alphaVantageBudgetLockTimeoutMs);
  const run = chain.then(guarded, guarded);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

export class AlphaVantageBudget {
  /**
   * `caller` is optional for back-compat with any other consumer, but FundamentalAgent/MacroAgent
   * (the only two real call sites) always pass their own name. Consensus Quality Audit
   * (2026-08-25): real DB evidence showed MacroAgent's tiny 3-request/day need was routinely shut
   * out entirely by FundamentalAgent burning through the shared budget across every distinct
   * symbol in the idea universe first — alphaVantageMacroReservedRequests carves out a slice of
   * the daily budget that only 'MacroAgent' may spend, so it is never structurally starved.
   */
  static async tryConsume(count: number = 1, nowMs: number = Date.now(), caller?: string): Promise<boolean> {
    if (count <= 0) return true;
    return enqueue(async () => {
      const budget = tradingSafety.alphaVantageDailyRequestBudget;
      const reserved = Math.max(0, Math.min(budget, tradingSafety.alphaVantageMacroReservedRequests));
      const effectiveBudget = caller === 'MacroAgent' ? budget : budget - reserved;
      const utcDate = utcDateKey(nowMs);
      const row = await ExternalDataCache.getStale<BudgetPayload>('alphavantage', 'daily-budget', null);
      const used = row && row.utcDate === utcDate && Number.isFinite(row.used) ? row.used : 0;
      if (used + count > effectiveBudget) return false;
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
