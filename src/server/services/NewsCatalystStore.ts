/**
 * Module: NewsCatalystStore
 *
 * In-memory last-N news catalysts per symbol + overnight STAGED_FOR_OPEN queue.
 * News is evidence, not an order. RiskEngine news_veto still reads news_clusters independently.
 * Off-hours analysis stages catalysts for market-open confluence — never places orders.
 *
 * Durable staging (2026-09-27 Phase 2 carryover). The `staged` queue below is the in-memory
 * mechanism `MarketOpenNewsConfluence` reads every 15s; it used to be purely module-level state
 * with zero DB reads/writes, so a restart between a catalyst being staged overnight and the next
 * market open silently lost it — the confluence worker would see an empty queue after restart.
 * `staged_news_catalysts` (drizzle/0075_staged_news_catalysts.sql) is a write-through durable
 * mirror of this queue only (not the ACTIVE per-symbol `bySymbol` history — lower operational
 * stakes, and news_clusters/news_predictions already carry the durable news record of truth).
 * Writes are fire-and-forget (never block the synchronous in-memory API these functions have
 * always exposed to callers); `rehydrateStagedCatalystsFromDb()` must be awaited at boot BEFORE
 * `MarketOpenNewsConfluence.start()` runs so a restart mid-overnight does not lose the queue.
 */
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import * as schema from '../db/schema';
import { computeCatalystExpiresAtMs, classifyCatalystHorizon } from '../news/catalystStagingTtl';
import { isUsEquityRegularSession } from '../news/newsSessionCadence';

export type NewsCatalystStatus = 'ACTIVE' | 'STAGED_FOR_OPEN' | 'EXPIRED' | 'CONSUMED';

export interface NewsCatalyst {
  traceId: string;
  symbol: string;
  headline: string;
  source: string;
  publishedAtMs: number | null;
  sentiment: number | null;
  credibility: number;
  catalystStrength: 'LOW' | 'MODERATE' | 'HIGH';
  tradingBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  contribution: number;
  reasoning: string;
  recordedAt: string;
  /** Horizon string from NewsIntelligence when available. */
  expectedHorizon?: string | null;
  /** Last known price at analysis time (never fabricated). Used for open confluence. */
  referencePrice?: number | null;
  status?: NewsCatalystStatus;
  expiresAtMs?: number | null;
  clusterId?: string | null;
}

const MAX_PER_SYMBOL = 12;
/**
 * 2026-10-08 leak-hunt fix: the per-symbol arrays were capped at MAX_PER_SYMBOL, but the
 * map's KEY COUNT (distinct symbols ever recorded) grew without bound - one entry per
 * symbol for process lifetime. Cap distinct symbols; eviction drops the least-recently-
 * recorded symbol first (insertion order refreshed on every record). 2000 is ~10x the
 * live discovery universe; an evicted-then-returning symbol simply re-warms.
 */
const MAX_SYMBOL_KEYS = 2000;
const bySymbol = new Map<string, NewsCatalyst[]>();
const staged: NewsCatalyst[] = [];

// Test-only hook: lets tests await the fire-and-forget DB write triggered by the most recent
// mutation before asserting on persisted state. Never awaited by production callers - the
// in-memory API these functions expose has always been synchronous and stays that way.
let lastPersistPromise: Promise<void> = Promise.resolve();

function trackPersist(p: Promise<void>): void {
  lastPersistPromise = p.catch(() => {});
}

/** Test-only: await the most recently triggered durable write before asserting on DB state. */
export async function flushPendingNewsCatalystWritesForTests(): Promise<void> {
  await lastPersistPromise;
}

/**
 * Bounded write into bySymbol: caps the per-symbol list at MAX_PER_SYMBOL (existing
 * behavior) AND the distinct-symbol key count at MAX_SYMBOL_KEYS (2026-10-08 leak-hunt
 * fix). Re-setting an existing key refreshes its insertion order so eviction always
 * drops the least-recently-recorded symbol.
 */
function setBySymbolBounded(key: string, list: NewsCatalyst[]): void {
  bySymbol.delete(key);
  bySymbol.set(key, list.slice(0, MAX_PER_SYMBOL));
  if (bySymbol.size > MAX_SYMBOL_KEYS) {
    const oldest = bySymbol.keys().next();
    if (!oldest.done) bySymbol.delete(oldest.value);
  }
}

function persistUpsert(c: NewsCatalyst): void {
  trackPersist((async () => {
    try {
      await db.insert(schema.stagedNewsCatalysts).values({
        traceId: c.traceId,
        symbol: c.symbol,
        headline: c.headline,
        source: c.source,
        publishedAtMs: c.publishedAtMs,
        sentiment: c.sentiment,
        credibility: c.credibility,
        catalystStrength: c.catalystStrength,
        tradingBias: c.tradingBias,
        contribution: c.contribution,
        reasoning: c.reasoning,
        recordedAt: c.recordedAt,
        expectedHorizon: c.expectedHorizon ?? null,
        referencePrice: c.referencePrice ?? null,
        status: c.status ?? 'ACTIVE',
        expiresAtMs: c.expiresAtMs ?? null,
        clusterId: c.clusterId ?? null,
        updatedAtMs: Date.now(),
      }).onConflictDoUpdate({
        target: schema.stagedNewsCatalysts.traceId,
        set: {
          status: c.status ?? 'ACTIVE',
          expiresAtMs: c.expiresAtMs ?? null,
          referencePrice: c.referencePrice ?? null,
          updatedAtMs: Date.now(),
        },
      });
    } catch (e) {
      console.error('[NewsCatalystStore] Failed to persist staged catalyst (in-memory state unaffected):', e);
    }
  })());
}

function persistStatus(traceId: string, status: NewsCatalystStatus): void {
  trackPersist((async () => {
    try {
      await db.update(schema.stagedNewsCatalysts)
        .set({ status, updatedAtMs: Date.now() })
        .where(eq(schema.stagedNewsCatalysts.traceId, traceId));
    } catch (e) {
      console.error('[NewsCatalystStore] Failed to persist staged-catalyst status (in-memory state unaffected):', e);
    }
  })());
}

function persistPruneBySize(traceIds: string[]): void {
  if (traceIds.length === 0) return;
  trackPersist((async () => {
    try {
      await db.delete(schema.stagedNewsCatalysts).where(inArray(schema.stagedNewsCatalysts.traceId, traceIds));
    } catch (e) {
      console.error('[NewsCatalystStore] Failed to prune persisted staged catalysts (in-memory state unaffected):', e);
    }
  })());
}

/**
 * Boot-time read-back. Must be awaited BEFORE `MarketOpenNewsConfluence.start()` so a restart
 * mid-overnight does not present an empty queue. Repopulates the in-memory `staged` array (and
 * each catalyst's `bySymbol` entry) from durable rows still in STAGED_FOR_OPEN status; rows that
 * expired while the process was down are marked EXPIRED here (not silently dropped) matching
 * pruneExpired()'s own always-visible-status behavior. Never throws — a read failure leaves the
 * in-memory store empty (fail-open on staging is safe: it only means fewer overnight catalysts are
 * available for the market-open confluence check, never a fabricated one).
 */
export async function rehydrateStagedCatalystsFromDb(): Promise<void> {
  try {
    const rows = await db.select().from(schema.stagedNewsCatalysts).where(eq(schema.stagedNewsCatalysts.status, 'STAGED_FOR_OPEN'));
    const nowMs = Date.now();
    for (const row of rows) {
      const catalyst: NewsCatalyst = {
        traceId: row.traceId,
        symbol: row.symbol,
        headline: row.headline,
        source: row.source,
        publishedAtMs: row.publishedAtMs,
        sentiment: row.sentiment,
        credibility: row.credibility,
        catalystStrength: row.catalystStrength as NewsCatalyst['catalystStrength'],
        tradingBias: row.tradingBias as NewsCatalyst['tradingBias'],
        contribution: row.contribution,
        reasoning: row.reasoning,
        recordedAt: row.recordedAt,
        expectedHorizon: row.expectedHorizon,
        referencePrice: row.referencePrice,
        status: row.expiresAtMs != null && row.expiresAtMs <= nowMs ? 'EXPIRED' : 'STAGED_FOR_OPEN',
        expiresAtMs: row.expiresAtMs,
        clusterId: row.clusterId,
      };
      if (catalyst.status === 'EXPIRED') {
        persistStatus(catalyst.traceId, 'EXPIRED');
        continue; // do not repopulate the live queue with something already stale
      }
      staged.unshift(catalyst);
      const list = bySymbol.get(catalyst.symbol) ?? [];
      list.unshift(catalyst);
      setBySymbolBounded(catalyst.symbol, list);
    }
    if (rows.length > 0) {
      console.log(`[NewsCatalystStore] Rehydrated ${staged.length} STAGED_FOR_OPEN catalyst(s) from durable storage at boot.`);
    }
  } catch (e) {
    console.error('[NewsCatalystStore] Failed to rehydrate staged catalysts from DB at boot - starting with an empty queue:', e);
  }
}

function pruneExpired(nowMs = Date.now()): void {
  for (let i = staged.length - 1; i >= 0; i--) {
    const c = staged[i];
    if (c.expiresAtMs != null && c.expiresAtMs <= nowMs) {
      c.status = 'EXPIRED';
      persistStatus(c.traceId, 'EXPIRED');
      staged.splice(i, 1);
    }
  }
}

/**
 * Record a catalyst. Outside RTH (or near session boundary), HIGH/MODERATE non-neutral
 * catalysts are also staged for the next open with an extended TTL.
 */
export function recordNewsCatalyst(catalyst: NewsCatalyst): NewsCatalyst {
  const key = catalyst.symbol.toUpperCase();
  const nowMs = Date.now();
  const inRth = isUsEquityRegularSession(nowMs);
  const shouldStage =
    !inRth &&
    catalyst.tradingBias !== 'NEUTRAL' &&
    (catalyst.catalystStrength === 'HIGH' || catalyst.catalystStrength === 'MODERATE');

  const enriched: NewsCatalyst = {
    ...catalyst,
    symbol: key,
    status: shouldStage ? 'STAGED_FOR_OPEN' : 'ACTIVE',
    // 2026-10-08 defect hunt (news D3): ACTIVE catalysts used to carry expiresAtMs=null and
    // never expired, persisting as "evidence" until the MAX_PER_SYMBOL rotation evicted them.
    // Give them the same horizon-based TTL staged catalysts get, so stale catalysts stop
    // influencing discovery prioritization. Discovery/observability only - never gates trades.
    expiresAtMs: shouldStage
      ? computeCatalystExpiresAtMs(nowMs, catalyst.expectedHorizon)
      : catalyst.expiresAtMs ?? computeCatalystExpiresAtMs(nowMs, catalyst.expectedHorizon),
  };

  const list = bySymbol.get(key) ?? [];
  list.unshift(enriched);
  setBySymbolBounded(key, list);

  if (shouldStage) {
    pruneExpired(nowMs);
    staged.unshift(enriched);
    persistUpsert(enriched);
    // Cap staged queue
    const overflow: string[] = [];
    while (staged.length > 200) overflow.push(staged.pop()!.traceId);
    persistPruneBySize(overflow);
  }
  return enriched;
}

export function getNewsCatalysts(symbol: string): NewsCatalyst[] {
  pruneExpired();
  // 2026-10-08 defect hunt (news D3): pruneExpired() marks staged catalysts EXPIRED but leaves
  // them in the bySymbol map, and ACTIVE (non-staged) catalysts carry expiresAtMs=null so they
  // never expired at all. Both then counted as "real catalyst evidence" indefinitely. Filter
  // to live evidence here: EXPIRED/CONSUMED never count, and a past expiresAtMs never counts.
  const nowMs = Date.now();
  return [...(bySymbol.get(symbol.toUpperCase()) ?? [])].filter(
    (c) => c.status !== 'EXPIRED' && c.status !== 'CONSUMED'
      && (c.expiresAtMs == null || c.expiresAtMs > nowMs),
  );
}

/**
 * Phase 28 (2026-09-02 P0 discovery fix). Real, reviewed bar for "does this symbol have genuine
 * catalyst evidence" - reuses the EXACT same strength/bias bar recordNewsCatalyst() already uses
 * to decide whether to stage a catalyst for market open, rather than inventing a new confidence
 * threshold. Used to (a) classify a MarketDataWorker rescue request as NEWS_CATALYST-priority and
 * (b) tag a news-triggered discovery-lineage entry as source=NEWS. Never gates a trade decision -
 * purely a discovery/observability signal.
 */
export function hasRealCatalystEvidence(symbol: string): boolean {
  return getNewsCatalysts(symbol).some(
    (c) => c.tradingBias !== 'NEUTRAL' && (c.catalystStrength === 'HIGH' || c.catalystStrength === 'MODERATE'),
  );
}

export function listRecentNewsCatalysts(limit = 20): NewsCatalyst[] {
  pruneExpired();
  const all = [...bySymbol.values()].flat();
  return all
    .sort((a, b) => (b.publishedAtMs ?? 0) - (a.publishedAtMs ?? 0))
    .slice(0, limit);
}

/** Active STAGED_FOR_OPEN catalysts that have not expired. */
export function listStagedForOpenCatalysts(limit = 50): NewsCatalyst[] {
  pruneExpired();
  return staged
    .filter((c) => c.status === 'STAGED_FOR_OPEN')
    .slice(0, limit);
}

export function markStagedCatalystConsumed(traceId: string): void {
  const c = staged.find((x) => x.traceId === traceId);
  if (c) c.status = 'CONSUMED';
  for (const list of bySymbol.values()) {
    const hit = list.find((x) => x.traceId === traceId);
    if (hit) hit.status = 'CONSUMED';
  }
  persistStatus(traceId, 'CONSUMED');
}

export function markStagedCatalystExpired(traceId: string): void {
  const c = staged.find((x) => x.traceId === traceId);
  if (c) c.status = 'EXPIRED';
  persistStatus(traceId, 'EXPIRED');
}

export function clearNewsCatalystsForTests(): void {
  bySymbol.clear();
  staged.length = 0;
  trackPersist((async () => {
    try {
      await db.delete(schema.stagedNewsCatalysts);
    } catch (e) {
      console.error('[NewsCatalystStore] Failed to clear durable staged catalysts for tests:', e);
    }
  })());
}

export { classifyCatalystHorizon };
