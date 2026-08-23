/**
 * Module: NewsCatalystStore
 *
 * In-memory last-N news catalysts per symbol + overnight STAGED_FOR_OPEN queue.
 * News is evidence, not an order. RiskEngine news_veto still reads news_clusters independently.
 * Off-hours analysis stages catalysts for market-open confluence — never places orders.
 */
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
const bySymbol = new Map<string, NewsCatalyst[]>();
const staged: NewsCatalyst[] = [];

function pruneExpired(nowMs = Date.now()): void {
  for (let i = staged.length - 1; i >= 0; i--) {
    const c = staged[i];
    if (c.expiresAtMs != null && c.expiresAtMs <= nowMs) {
      c.status = 'EXPIRED';
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
    expiresAtMs: shouldStage
      ? computeCatalystExpiresAtMs(nowMs, catalyst.expectedHorizon)
      : catalyst.expiresAtMs ?? null,
  };

  const list = bySymbol.get(key) ?? [];
  list.unshift(enriched);
  bySymbol.set(key, list.slice(0, MAX_PER_SYMBOL));

  if (shouldStage) {
    pruneExpired(nowMs);
    staged.unshift(enriched);
    // Cap staged queue
    while (staged.length > 200) staged.pop();
  }
  return enriched;
}

export function getNewsCatalysts(symbol: string): NewsCatalyst[] {
  pruneExpired();
  return [...(bySymbol.get(symbol.toUpperCase()) ?? [])];
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
}

export function markStagedCatalystExpired(traceId: string): void {
  const c = staged.find((x) => x.traceId === traceId);
  if (c) c.status = 'EXPIRED';
}

export function clearNewsCatalystsForTests(): void {
  bySymbol.clear();
  staged.length = 0;
}

export { classifyCatalystHorizon };
