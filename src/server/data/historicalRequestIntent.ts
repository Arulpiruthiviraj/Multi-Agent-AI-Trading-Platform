/**
 * historicalRequestIntent.ts - carries WHY a historical-bar request is being made down to the IBKR request scheduler.
 *
 * A request's intent decides its scheduling class (P0 position data ... P3 research backfill; see
 * src/brokers/ibkrHistoricalScheduler.ts). The call chain Quant/PortfolioMonitor/evaluator -> HistoricalDataGateway ->
 * HistoricalBarProvider -> IbkrSocketSession has no spare parameter slot, so intent travels in AsyncLocalStorage. A caller that
 * does not declare an intent is classified by the age of its window (see inferHistoricalIntent) - a request for a window that
 * ended long ago can never be live-session work.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { HistoricalIntent } from '../../brokers/ibkrHistoricalScheduler';

export interface HistoricalIntentContext {
  intent: HistoricalIntent;
  /** Optional: aborting it tells the scheduler this caller no longer needs the bars. */
  signal?: AbortSignal;
}

const store = new AsyncLocalStorage<HistoricalIntentContext>();

export function runWithHistoricalIntent<T>(intent: HistoricalIntent, fn: () => T, signal?: AbortSignal): T {
  return store.run({ intent, signal }, fn);
}

export function currentHistoricalIntent(): HistoricalIntentContext | undefined {
  return store.getStore();
}

/** Fallback classification when no caller declared an intent. */
export function inferHistoricalIntent(endMs: number, nowMs: number, foregroundWindowMaxAgeMs: number): HistoricalIntent {
  return endMs >= nowMs - foregroundWindowMaxAgeMs ? 'RECENT_CACHE_REFRESH' : 'RESEARCH_BACKFILL';
}
