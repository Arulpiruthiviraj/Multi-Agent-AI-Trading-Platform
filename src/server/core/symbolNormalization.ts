/**
 * Real, previously-duplicated dedup logic (2026-09-02 forensic-audit follow-up,
 * docs/audits/ARGUS_PHASE18_19_UNIVERSAL_DISCOVERY_RESEARCH.md §14/§27): five separate call sites
 * across OpportunityDiscovery.ts, SnapshotScanner.ts, MomentumUniverseScanner.ts, and
 * MarketUniverseScanner.ts each independently re-implemented the identical
 * trim().toUpperCase() + Set pattern. Consolidated here so every discovery-source symbol list is
 * normalized/deduped exactly the same way, in one place.
 */
import { looksLikeListedTicker } from '../ai/AIOutputValidator';

/** Trim, uppercase, dedupe, drop empties. Matches OpportunityDiscovery.getOpportunityScanUniverse()'s
 *  original behavior exactly - no ticker-shape validation (callers that already validate downstream,
 *  e.g. via evaluateOpportunityCandidate(), don't need it duplicated here). */
export function normalizeSymbols(raw: Array<string | null | undefined>): string[] {
  return [...new Set(raw.map((s) => String(s ?? '').trim().toUpperCase()).filter(Boolean))];
}

/** Same normalization, plus a real ticker-shape check (looksLikeListedTicker) - matches
 *  SnapshotScanner/MomentumUniverseScanner's original behavior exactly. */
export function normalizeAndValidateSymbols(raw: Array<string | null | undefined>): string[] {
  return [...new Set(raw.map((s) => String(s ?? '').trim().toUpperCase()).filter((s) => looksLikeListedTicker(s)))];
}
