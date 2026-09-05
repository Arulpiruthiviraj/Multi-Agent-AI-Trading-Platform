/**
 * Session-Aware Trading Architecture Phase 5 follow-up (2026-09-05,
 * docs/audits/ARGUS_PREMARKET_TRADING_IMPLEMENTATION.md). Real average-daily-volume liquidity data
 * for RiskEngine's gate 25 (extended_hours_execution_policy) - ExtendedHoursExecutionPolicy.ts
 * originally left this deliberately NOT_IMPLEMENTED ("no data source this gate does not cleanly
 * have access to"). It turns out one already exists: MarketUniverseScanner.ts's
 * fetchAvgDailyVolumeShares() (the same real Alpaca bars endpoint / broadUniverseAdvLookbackDays
 * lookback the broad-universe liquidity screen already uses) - this module reuses that function
 * rather than computing a second, duplicate average.
 *
 * A RiskEngine gate evaluation is synchronous per order and must never block on a live network
 * call, so ADV is a background-refreshed, synchronously-read cache. A symbol with no cached (or
 * never-successfully-fetched) entry evaluates as "no liquidity data" - fails closed, exactly like
 * every other "never fabricate" gate in this codebase (see gate 15's NON_FINITE_PRICE etc., or
 * this same file's own spreadBps-null handling).
 */
import { fetchAvgDailyVolumeShares } from '../continuous/MarketUniverseScanner';
import { continuousIntelligence } from '../config/continuousIntelligence';

interface CacheEntry {
  shares: number;
  fetchedAtMs: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Set<string>();

/** Reuses the SAME cache TTL as the broad-universe tradable-assets list (24h) - ADV is a
 *  slow-moving daily statistic, not a value that needs sub-hour freshness. */
const CACHE_TTL_MS = continuousIntelligence.broadUniverseAssetsCacheTtlMs;

async function refreshOne(symbol: string): Promise<void> {
  if (inflight.has(symbol)) return;
  inflight.add(symbol);
  try {
    const result = await fetchAvgDailyVolumeShares([symbol]);
    const shares = result.get(symbol);
    if (shares != null) cache.set(symbol, { shares, fetchedAtMs: Date.now() });
  } catch (e) {
    console.error(`[ExtendedHoursLiquidityCache] Failed to refresh ADV for ${symbol} (gate 25 fails closed until this succeeds)`, e);
  } finally {
    inflight.delete(symbol);
  }
}

/**
 * Synchronous read for RiskEngine's gate 25. Never blocks and never makes a network call inline -
 * a cold or stale entry triggers a fire-and-forget background refresh for the NEXT evaluation and
 * returns either null (never fetched yet - fail closed) or the last-known value (stale but real,
 * not fabricated).
 */
export function getCachedAvgDailyVolumeShares(symbol: string, now: Date = new Date()): number | null {
  const entry = cache.get(symbol);
  if (!entry) {
    void refreshOne(symbol);
    return null;
  }
  if (now.getTime() - entry.fetchedAtMs > CACHE_TTL_MS) {
    void refreshOne(symbol);
  }
  return entry.shares;
}

/** Test-only reset - production callers never need this. */
export function resetExtendedHoursLiquidityCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

/** Test-only direct write - lets a test exercise the "warm cache" path synchronously without
 *  waiting on a real (mocked-away) network fetch. Production callers never need this; the cache is
 *  populated only via refreshOne() above. */
export function setCachedAvgDailyVolumeSharesForTests(symbol: string, shares: number, fetchedAtMs: number = Date.now()): void {
  cache.set(symbol, { shares, fetchedAtMs });
}
