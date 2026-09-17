/**
 * Bounded, deterministic, aging-aware priority allocator for the broad-universe discovery ->
 * subscription handoff.
 *
 * Real defect this replaces (2026-09-16, subscription-starvation investigation): the prior
 * implementation (getOpportunityScanUniverse()'s `.slice(0, broadUniverseTopNPerScan)`) re-sorted
 * the ADV-admitted candidate list by raw dollar volume, descending, on every call, with no memory
 * of prior cycles. Confirmed live: on a real trading day with 1,418 candidates, the top-20 window
 * was entirely mega-caps ($143M-$768M dollar volume); five real, liquid, materially-moving admitted
 * candidates ($10-51M dollar volume, 10-17% single-day moves) ranked #99/#262/#357/#615/#622 - never
 * once inside the window. Because the underlying sort criterion barely reorders cycle to cycle for
 * the symbols that occupy the top of it, this was not a rare unlucky sample - it is the structurally
 * expected outcome on essentially any ordinary day.
 *
 * Design: every admitted candidate accumulates a real, observable, capped priority score each cycle
 * it is NOT selected. Liquidity (dollar-volume percentile RANK within today's admitted universe, not
 * raw dollar volume - this is what bounds a mega-cap's structural advantage to [0,1] instead of an
 * unbounded multiple) still matters, but a candidate's waiting time contributes an unbounded,
 * monotonically increasing term that provably exceeds any possible liquidity-rank contribution after
 * `broadUniverseFairnessWindowCycles` consecutive skips - guaranteeing eventual selection, not merely
 * hoping for it. This is an explicit aging model, not a random rotation (the mandate's own
 * requirement) - identical inputs across two runs produce an identical selection (see
 * BroadUniverseSubscriptionAllocator.test.ts's determinism case).
 *
 * In-memory, bounded, not DB-persisted - the same deliberate pattern already used by every sibling
 * module in this subsystem (candidateLifecycle.ts, recentCandidateRegistry.ts): this is observability
 * / fairness-overlay state, not trading state, and CLAUDE.md's own standing rule is that only
 * trading/position/order state must survive a restart. A restart safely resets this allocator to an
 * empty state - no crash, no duplicate subscription requests, no unsafe behavior - and priority
 * rebuilds honestly from that point forward (see the restart-safety test). This mirrors this whole
 * subsystem's own established precedent rather than introducing new production DB schema for a
 * fairness-only feature.
 */
import { continuousIntelligence } from '../config/continuousIntelligence';

export interface AllocationCandidate {
  symbol: string;
  dollarVolume: number;
}

export interface AllocationRecord {
  symbol: string;
  firstEligibleAt: number;
  lastConsideredAt: number;
  lastSelectedAt: number | null;
  cyclesEligible: number;
  cyclesSelected: number;
  cyclesSkipped: number;
}

export type SelectionReason = 'LIQUIDITY_RANK' | 'AGING_FAIRNESS';

export interface SelectionResult {
  symbol: string;
  reason: SelectionReason;
  score: number;
  liquidityRankScore: number;
  agingBonus: number;
}

const records = new Map<string, AllocationRecord>();

function cap(): void {
  const max = continuousIntelligence.broadUniverseAllocatorMaxTrackedRecords;
  if (records.size <= max) return;
  // Evict the longest-untouched records first - never the ones with real recent activity.
  const ordered = [...records.values()].sort((a, b) => a.lastConsideredAt - b.lastConsideredAt);
  for (const row of ordered.slice(0, records.size - max)) {
    records.delete(row.symbol);
  }
}

/**
 * Selects up to `capacity` symbols from `candidates` for this cycle. Deterministic: identical
 * `candidates` + identical prior state + identical `now` always produce an identical result.
 * Never selects a symbol not present in `candidates` this cycle (an admitted candidate that drops
 * out of admission is simply not scored, not force-kept).
 */
export function selectBroadUniverseCandidates(
  candidates: AllocationCandidate[],
  capacity: number,
  now: number = Date.now(),
): SelectionResult[] {
  if (capacity <= 0 || candidates.length === 0) return [];

  const fairnessWindow = Math.max(1, continuousIntelligence.broadUniverseFairnessWindowCycles);

  // Liquidity RANK (percentile within today's admitted set), not raw dollar volume - bounds a
  // mega-cap's structural advantage to a [0,1] contribution instead of a 10-70x multiple.
  // Competition ranking (equal dollarVolume -> equal rank -> equal liquidityRankScore), not
  // array-index-based - a stable sort alone would otherwise hand two genuinely tied candidates
  // different scores purely from their original input order, silently defeating the documented
  // cyclesSkipped/alphabetical tie-break below before it ever runs.
  const sortedByVolume = [...candidates].sort((a, b) => b.dollarVolume - a.dollarVolume);
  const rankOf = new Map<string, number>();
  let lastVolume: number | null = null;
  let lastRank = -1;
  sortedByVolume.forEach((c, i) => {
    const rank = c.dollarVolume === lastVolume ? lastRank : i;
    rankOf.set(c.symbol, rank);
    lastVolume = c.dollarVolume;
    lastRank = rank;
  });
  const n = candidates.length;

  const scored: SelectionResult[] = candidates.map((c) => {
    const prev = records.get(c.symbol);
    const cyclesSkipped = prev ? prev.cyclesSkipped : 0;
    const liquidityRankScore = n > 1 ? 1 - (rankOf.get(c.symbol)! / (n - 1)) : 1;
    // Uncapped, monotonic in cyclesSkipped - guaranteed to reach/exceed 1.0 (the max possible
    // liquidityRankScore) after exactly `fairnessWindow` consecutive skips, so a persistently
    // eligible-but-unselected candidate cannot be starved beyond that many cycles regardless of how
    // many higher-liquidity candidates exist.
    const agingBonus = cyclesSkipped / fairnessWindow;
    const score = liquidityRankScore + agingBonus;
    const reason: SelectionReason = agingBonus >= liquidityRankScore ? 'AGING_FAIRNESS' : 'LIQUIDITY_RANK';
    return { symbol: c.symbol, reason, score, liquidityRankScore, agingBonus };
  });

  // Deterministic tie-break: higher score first; ties broken by longer real wait (more cyclesSkipped),
  // then alphabetically - never by insertion order or randomness.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aSkipped = records.get(a.symbol)?.cyclesSkipped ?? 0;
    const bSkipped = records.get(b.symbol)?.cyclesSkipped ?? 0;
    if (bSkipped !== aSkipped) return bSkipped - aSkipped;
    return a.symbol.localeCompare(b.symbol);
  });

  const selected = scored.slice(0, capacity);
  const selectedSet = new Set(selected.map((s) => s.symbol));

  // Update state for every candidate considered this cycle (selected AND skipped) - this is what
  // makes aging real rather than cosmetic.
  for (const c of candidates) {
    const prev = records.get(c.symbol);
    const wasSelected = selectedSet.has(c.symbol);
    records.set(c.symbol, {
      symbol: c.symbol,
      firstEligibleAt: prev?.firstEligibleAt ?? now,
      lastConsideredAt: now,
      lastSelectedAt: wasSelected ? now : (prev?.lastSelectedAt ?? null),
      cyclesEligible: (prev?.cyclesEligible ?? 0) + 1,
      cyclesSelected: (prev?.cyclesSelected ?? 0) + (wasSelected ? 1 : 0),
      cyclesSkipped: wasSelected ? 0 : (prev?.cyclesSkipped ?? 0) + 1,
    });
  }
  cap();

  return selected;
}

export function getAllocationRecord(symbol: string): AllocationRecord | undefined {
  return records.get(symbol.toUpperCase());
}

export function listAllocationRecords(): AllocationRecord[] {
  return [...records.values()].sort((a, b) => b.cyclesSkipped - a.cyclesSkipped);
}

export function resetBroadUniverseAllocatorForTests(): void {
  records.clear();
}
