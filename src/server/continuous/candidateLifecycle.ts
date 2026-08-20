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

export function getCandidate(symbol: string): CandidateRecord | undefined {
  return candidates.get(symbol.toUpperCase());
}

export function listCandidates(): CandidateRecord[] {
  return [...candidates.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function resetCandidatesForTests(): void {
  candidates.clear();
}
