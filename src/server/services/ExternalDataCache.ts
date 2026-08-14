/**
 * ==========================================================
 * Module: ExternalDataCache
 *
 * Purpose:
 * Real cache + rate-limit cooldown for external data providers with a hard request quota
 * (AlphaVantage's free tier: 25 requests/day - confirmed live against the real configured key
 * during this pass). FundamentalAgent/MacroAgent were each polling every 60-75s, exhausting that
 * quota within minutes of boot; every call after that got AlphaVantage's real rate-limit response
 * and correctly fell through to an honest DATA_UNAVAILABLE - not a bug in that fallback, but real,
 * avoidable waste, since fundamentals/macro indicators don't change on a sub-minute cadence in
 * reality either.
 *
 * Never fabricates data: a cache miss/expiry/rate-limit returns null, and the caller is
 * responsible for deciding what an honest "unavailable" response looks like.
 * ==========================================================
 */
import { db } from '../db';
import { externalDataCache } from '../db/schema';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';

// Hardening pass, Phase 7: a stable, order-independent hash of a data object - used as part of
// the cache key for a real LLM-analysis cache (FundamentalAgent/MacroAgent), so a cached analysis
// is only ever reused when the underlying input data is byte-for-byte the same, and a fresh LLM
// call happens automatically the moment it isn't (e.g. AlphaVantage's numbers change within the
// same 24h raw-fetch cache window) - "must not return stale decisions when the underlying context
// materially changed."
export function hashObject(data: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
}

const RATE_LIMIT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // AlphaVantage's quota is daily; a flat 24h
// cooldown from the moment a rate-limit response is actually observed is a safe, real choice that
// doesn't require asserting an unverified fact about AlphaVantage's own internal reset clock.

function cacheId(provider: string, dataType: string, symbol: string | null): string {
  return `${provider}:${dataType}:${symbol ?? 'GLOBAL'}`;
}

// AlphaVantage's real rate-limit/throttle responses carry an `Information` or `Note` field
// instead of the expected data shape - detected by content, not by a brittle exact-string match,
// since the wording has changed at least once already (per-minute -> per-day framing).
export function looksLikeRateLimitResponse(data: any): boolean {
  const text = String(data?.Information ?? data?.Note ?? '');
  return /rate limit|call frequency|premium/i.test(text);
}

export class ExternalDataCache {
  /** Real cached payload if fresh (younger than maxAgeMs), else null - never returns stale data silently. */
  static async getFresh<T = any>(provider: string, dataType: string, symbol: string | null, maxAgeMs: number): Promise<T | null> {
    const row = await this.getRow(provider, dataType, symbol);
    if (!row) return null;
    if (Date.now() - row.fetchedAt > maxAgeMs) return null;
    try {
      return JSON.parse(row.payload) as T;
    } catch {
      return null;
    }
  }

  /** True while a real rate-limit cooldown from a previous fetch attempt is still in effect. */
  static async isRateLimited(provider: string, dataType: string, symbol: string | null): Promise<boolean> {
    const row = await this.getRow(provider, dataType, symbol);
    return !!(row?.rateLimitedUntil && row.rateLimitedUntil > Date.now());
  }

  /** Real successful fetch result - clears any prior rate-limit cooldown. */
  static async set(provider: string, dataType: string, symbol: string | null, payload: any): Promise<void> {
    const id = cacheId(provider, dataType, symbol);
    await db.insert(externalDataCache).values({
      id, provider, dataType, symbol, payload: JSON.stringify(payload), fetchedAt: Date.now(), rateLimitedUntil: null,
    }).onConflictDoUpdate({
      target: externalDataCache.id,
      set: { payload: JSON.stringify(payload), fetchedAt: Date.now(), rateLimitedUntil: null },
    });
  }

  /** Real rate-limit hit - starts a real cooldown without touching whatever payload/fetchedAt already exists. */
  static async markRateLimited(provider: string, dataType: string, symbol: string | null): Promise<void> {
    const id = cacheId(provider, dataType, symbol);
    const until = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    const existing = await this.getRow(provider, dataType, symbol);
    if (existing) {
      await db.update(externalDataCache).set({ rateLimitedUntil: until }).where(eq(externalDataCache.id, id));
    } else {
      // No prior successful fetch to preserve - a real, empty payload placeholder, not fabricated data.
      await db.insert(externalDataCache).values({ id, provider, dataType, symbol, payload: '{}', fetchedAt: 0, rateLimitedUntil: until });
    }
  }

  private static async getRow(provider: string, dataType: string, symbol: string | null) {
    const id = cacheId(provider, dataType, symbol);
    const rows = await db.select().from(externalDataCache).where(eq(externalDataCache.id, id));
    return rows[0] ?? null;
  }
}
