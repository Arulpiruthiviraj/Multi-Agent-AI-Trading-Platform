/**
 * In-memory candidate lifecycle for the opportunity overlay.
 * Bounded. Not a trade, not a fill, not a second execution path.
 */
import { continuousIntelligence } from '../config/continuousIntelligence';

export type CandidateState =
  | 'DISCOVERED'
  | 'WATCHING'
  | 'STALE'
  | 'FILTERED_OUT'
  | 'PROMOTED';

export interface CandidateRecord {
  symbol: string;
  state: CandidateState;
  assetClass: string;
  reason: string;
  updatedAt: number;
  lastIdeaAt: number | null;
}

const candidates = new Map<string, CandidateRecord>();

function cap(): void {
  const max = continuousIntelligence.maxCandidateRecords;
  if (candidates.size <= max) return;
  const ordered = [...candidates.values()].sort((a, b) => a.updatedAt - b.updatedAt);
  for (const row of ordered.slice(0, candidates.size - max)) {
    candidates.delete(row.symbol);
  }
}

export function upsertCandidate(input: {
  symbol: string;
  state: CandidateState;
  assetClass?: string;
  reason?: string;
  now?: number;
}): CandidateRecord {
  const symbol = input.symbol.toUpperCase();
  const now = input.now ?? Date.now();
  const prev = candidates.get(symbol);
  const next: CandidateRecord = {
    symbol,
    state: input.state,
    assetClass: input.assetClass || prev?.assetClass || 'UNKNOWN',
    reason: input.reason || prev?.reason || '',
    updatedAt: now,
    lastIdeaAt: prev?.lastIdeaAt ?? null,
  };
  candidates.set(symbol, next);
  cap();
  return next;
}

export function markCandidatePromoted(symbol: string, now: number = Date.now()): void {
  const key = symbol.toUpperCase();
  const prev = candidates.get(key);
  candidates.set(key, {
    symbol: key,
    state: 'PROMOTED',
    assetClass: prev?.assetClass || 'UNKNOWN',
    reason: 'screener_idea',
    updatedAt: now,
    lastIdeaAt: now,
  });
  cap();
}

/**
 * Phase 9 (time-bounded evaluation window, 2026-08-31). Real gap confirmed: 'STALE' has been a
 * declared CandidateState since this module's own header comment first listed it, but nothing in
 * the codebase ever actually set it - a candidate that stopped being re-scanned (e.g. it fell out
 * of the broad-universe shortlist) just sat at its last real state (DISCOVERED/WATCHING) forever,
 * with no candidate ever reaching STALE. This does not gate consensus/RiskEngine/OMS in any way -
 * it only keeps this observability-facing lifecycle honest about age, matching what listCandidates()
 * callers (the continuous-intelligence status route, CLI ranking) already assume STALE means.
 * Never demotes PROMOTED/FILTERED_OUT (those are real, already-final outcomes for that scan).
 */
export function expireStaleCandidates(maxAgeMs: number, now: number = Date.now()): number {
  let expired = 0;
  for (const [symbol, record] of candidates) {
    if (record.state === 'PROMOTED' || record.state === 'FILTERED_OUT' || record.state === 'STALE') continue;
    if (now - record.updatedAt > maxAgeMs) {
      candidates.set(symbol, { ...record, state: 'STALE' });
      expired++;
    }
  }
  return expired;
}

export function getCandidate(symbol: string): CandidateRecord | undefined {
  return candidates.get(symbol.toUpperCase());
}

export function listCandidates(): CandidateRecord[] {
  return [...candidates.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function resetCandidatesForTests(): void {
  candidates.clear();
}
