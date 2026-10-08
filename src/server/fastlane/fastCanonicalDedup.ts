/**
 * Fast Lane -> Canonical Decision Spine: idempotency + evidence collision classification.
 *
 * 2026-10-06. Two separate, honestly-scoped concerns:
 *
 * 1. Idempotency (Section 5): the SAME FastEvaluationResult delivered N times must produce exactly
 *    ONE canonical idea, not N. Bounded in-memory cache keyed by evidenceFingerprint - no new
 *    unrelated dedup store invented; this mirrors the same bounded-Map pattern every sibling
 *    fast-lane module already uses (in-memory, resets on restart, never DB-persisted, matching
 *    this subsystem's own established precedent for non-trading-state data).
 *
 * 2. Evidence collision classification (Section 6): purely OBSERVATIONAL. The REAL, load-bearing
 *    protection against independence inflation is `resolveIndependentEvidenceGroup()`
 *    (evidenceIndependence.ts) registering `FastOpportunityLane` into the SAME group as
 *    `QuantEngine`/`JavaCoreEnsemble` - that is what ChiefTrader's actual consensus math already
 *    uses, proven in ChiefTraderAgent.test.ts. This module's classification does NOT gate
 *    anything; it exists so an operator/forensic trace can see WHY two pieces of evidence were (or
 *    were not) treated as the same underlying fact. Honestly scoped: this module can confidently
 *    identify identical-strategy duplication (real fingerprint match) and can rule out
 *    correlation when strategies/symbols differ, but it does NOT claim to detect cross-strategy
 *    factor correlation (e.g. "momentum strategy A is secretly correlated with trend strategy B") -
 *    that would require a real, source-verified correlation matrix this codebase does not have for
 *    arbitrary TS strategy pairs (the ONE place such a matrix exists,
 *    `QuantEnsembleEngine.java`'s `defaultFamilyCorrelationMatrix()`, is itself documented as a
 *    reviewed ASSUMPTION, not a measured value - grouping requires proof, not suspicion, same
 *    standard `evidenceIndependence.ts` already applies).
 */
import { computeEvidenceFingerprint, convertFastEvaluationToCanonicalIdea } from './fastCanonicalAdapter';
import type { CanonicalIdeaFromFastLane, FastCanonicalConversionRejectReason } from './fastCanonicalAdapter';
import type { FastEvaluationResult, FastOpportunityCandidate } from './FastOpportunityCandidate';
import {
  logFastCanonicalIdeaCreated,
  logFastCanonicalIdeaDeduped,
  logFastCanonicalIdeaRejected,
} from './fastLaneObservability';
import { tradingSafety } from '../config/tradingSafety';

const canonicalIdeaCache = new Map<string, CanonicalIdeaFromFastLane>();

/**
 * Returns the cached canonical idea for this fingerprint if one already exists (idempotent
 * re-delivery), otherwise stores and returns the newly-built one. The SAME FastEvaluationResult
 * (same strategy/symbol/side/dataAsOf-bucket) delivered any number of times returns the identical
 * cached object, never a second distinct canonical idea.
 */
export function getOrCacheCanonicalIdea(idea: CanonicalIdeaFromFastLane): { idea: CanonicalIdeaFromFastLane; wasAlreadyCached: boolean } {
  const key = idea.evidence.evidenceFingerprint;
  const existing = canonicalIdeaCache.get(key);
  if (existing) return { idea: existing, wasAlreadyCached: true };
  canonicalIdeaCache.set(key, idea);
  // 2026-10-08 (D5): the header's "bounded in-memory cache" claim is now true - oldest-first
  // eviction (Map preserves insertion order) keeps this from growing without bound in a 24/7
  // process. Evicting an old fingerprint only means a re-delivered old evaluation rebuilds its
  // canonical idea object instead of reusing the identical one - no decision changes.
  const maxEntries = tradingSafety.fastLaneCanonicalIdeaCacheMaxEntries;
  while (canonicalIdeaCache.size > maxEntries) {
    const oldest = canonicalIdeaCache.keys().next();
    if (oldest.done) break;
    canonicalIdeaCache.delete(oldest.value);
  }
  return { idea, wasAlreadyCached: false };
}

export type ProcessFastEvaluationResult =
  | { ok: true; idea: CanonicalIdeaFromFastLane; wasAlreadyCached: boolean }
  | { ok: false; reason: FastCanonicalConversionRejectReason };

/**
 * Top-level, observability-wired entry point: converts a FastEvaluationResult and deduplicates
 * it against any prior canonical idea with the same evidence fingerprint, logging
 * FAST_CANONICAL_IDEA_CREATED / FAST_CANONICAL_IDEA_DEDUPED / FAST_CANONICAL_IDEA_REJECTED as
 * appropriate. Still never calls emitTradeIdea - see this file's own header.
 */
export function processFastEvaluationForCanonicalIdea(
  result: FastEvaluationResult,
  candidate: FastOpportunityCandidate,
): ProcessFastEvaluationResult {
  const converted = convertFastEvaluationToCanonicalIdea(result, candidate);
  // `=== false` (not `!converted.ok`) - this project's tsconfig has no strict/strictNullChecks,
  // under which a bare negation does not narrow a discriminated union reliably. Matches the same
  // idiom EventBus.ts's own emitTradeIdea() already uses for the identical gateTradeIdea() union.
  if (converted.ok === false) {
    logFastCanonicalIdeaRejected(candidate.id, candidate.symbol, converted.reason);
    return { ok: false, reason: converted.reason };
  }
  const { idea, wasAlreadyCached } = getOrCacheCanonicalIdea(converted.idea);
  if (wasAlreadyCached) {
    logFastCanonicalIdeaDeduped(candidate.id, result.id, idea.evidence.fastEvaluationId, candidate.symbol);
  } else {
    logFastCanonicalIdeaCreated(candidate.id, result.id, idea.evidence.fastEvaluationId, candidate.symbol, idea.strategy);
  }
  return { ok: true, idea, wasAlreadyCached };
}

export function resetFastCanonicalDedupForTests(): void {
  canonicalIdeaCache.clear();
}

export function fastCanonicalDedupCacheSizeForTests(): number {
  return canonicalIdeaCache.size;
}

export type EvidenceCollisionClassification =
  | 'SAME_STRATEGY_SAME_EVIDENCE'
  | 'SAME_STRATEGY_NEWER_EVIDENCE'
  | 'DIFFERENT_STRATEGY_UNKNOWN_CORRELATION'
  | 'GENUINELY_INDEPENDENT_EVIDENCE';

export interface EvidenceDescriptor {
  strategy: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  dataAsOf: number | null;
}

/**
 * Classifies how `incoming` (Fast Lane) evidence relates to `existing` (e.g. the normal
 * QuantEngine path's) evidence for the SAME symbol, for observability/forensic tracing only - does
 * not gate any real decision. `existing: null` (no prior evidence for this symbol) always
 * classifies as GENUINELY_INDEPENDENT_EVIDENCE.
 */
export function classifyEvidenceCollision(
  incoming: EvidenceDescriptor,
  existing: EvidenceDescriptor | null,
): EvidenceCollisionClassification {
  if (!existing || existing.symbol !== incoming.symbol) return 'GENUINELY_INDEPENDENT_EVIDENCE';
  if (existing.strategy !== incoming.strategy) return 'DIFFERENT_STRATEGY_UNKNOWN_CORRELATION';
  // Same strategy, same symbol from here on.
  const incomingFp = computeEvidenceFingerprint(incoming);
  const existingFp = computeEvidenceFingerprint(existing);
  if (incomingFp === existingFp) return 'SAME_STRATEGY_SAME_EVIDENCE';
  // Same strategy/symbol/side, but a different (necessarily later, since Fast Lane evaluates
  // on-demand after the normal path's own cycle) data-as-of bucket - genuinely fresher evidence
  // of the identical underlying signal, not a new independent fact.
  if (existing.side === incoming.side) return 'SAME_STRATEGY_NEWER_EVIDENCE';
  return 'GENUINELY_INDEPENDENT_EVIDENCE'; // same strategy, opposite side - a real disagreement, not a duplicate
}
