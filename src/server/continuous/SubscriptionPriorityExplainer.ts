/**
 * Phase 4D (Dynamic Subscription Priority Queue, 2026-08-26).
 *
 * Audit finding (source-verified, not guessed): a real priority/hysteresis mechanism for the
 * dynamic (non-anchor) streaming slots already exists and is already working -
 * MarketDataWorker.pruneLeastActiveWatchSymbols() evicts the lowest (momentumScore, ticks,
 * lastTickTime) non-protected symbol, respects a dwell-protection window
 * (continuousIntelligence.minDynamicDwellMs/minDynamicDwellTicks) so a freshly-subscribed symbol
 * cannot be evicted immediately, and OpportunityDiscovery.planSnapshotHotSwap() already requires a
 * challenger to beat the weakest active dynamic symbol's score by a real hysteresis edge
 * (continuousIntelligence.snapshotMomentumScoreEdge) before a swap is even proposed. The actual
 * capacity ceiling (IBKR ~90) was NOT the bottleneck on 2026-08-26 (41 of 90 used) -
 * momentumHotSwapSlotsPerCycle=1 caps how many NEW promotions OpportunityDiscovery proposes per
 * cycle once slots are full.
 *
 * What was genuinely missing, and what this module adds: NONE of the above decisions were
 * persisted or queryable - an operator had no way to ask "why was symbol X not promoted" or "why
 * did symbol Y lose its slot" without reading server console output. This module does not
 * replace, duplicate, or alter that decision logic - it recomputes the IDENTICAL rule
 * (planSnapshotHotSwap's own score-edge/occupancy logic) purely to explain every candidate's
 * outcome, then the caller persists the result. Never touches OMS/RiskEngine/BrokerManager,
 * never subscribes to anything itself.
 */
import type { SnapshotCandidate } from './SnapshotScanner';

export type SubscriptionDecisionAction = 'PROMOTED' | 'NOT_PROMOTED' | 'ALREADY_ACTIVE';

export interface SubscriptionDecision {
  symbol: string;
  action: SubscriptionDecisionAction;
  score: number;
  reason: string;
  /** For a proposed swap, the currently-active symbol this candidate would have displaced. */
  displaces?: string;
}

export interface EvictionDecision {
  symbol: string;
  score: number;
  ticks: number;
  reason: string;
}

/**
 * Re-derives, for EVERY top-ranked candidate (not just the ones selected), why it was or was not
 * promoted this cycle - using the identical rule planSnapshotHotSwap already applies. `top` should
 * be the same momentum-ranked candidate list, `active`/`activeDynamic`/`emptySlots`/`maxSwaps`/
 * `scoreEdge`/`scoreOf` the same inputs already passed to the real function at the same call site.
 */
export function explainSnapshotHotSwapDecisions(opts: {
  top: SnapshotCandidate[];
  active: Set<string>;
  activeDynamic: string[];
  emptySlots: number;
  maxSwaps: number;
  scoreEdge: number;
  scoreOf: (symbol: string) => number;
}): SubscriptionDecision[] {
  const decisions: SubscriptionDecision[] = [];
  const occupied = new Set(opts.active);
  let empties = opts.emptySlots;
  const dynamicLeft = new Set(opts.activeDynamic);
  const swapCap = opts.emptySlots > 0
    ? Math.max(0, opts.maxSwaps)
    : Math.min(1, Math.max(0, opts.maxSwaps));
  let promotedCount = 0;

  for (const cand of opts.top) {
    if (occupied.has(cand.symbol) && opts.active.has(cand.symbol)) {
      decisions.push({ symbol: cand.symbol, action: 'ALREADY_ACTIVE', score: cand.momentumScore, reason: 'Already an active subscription.' });
      continue;
    }
    if (promotedCount >= swapCap) {
      decisions.push({ symbol: cand.symbol, action: 'NOT_PROMOTED', score: cand.momentumScore, reason: `Hot-swap cap reached this cycle (${swapCap} slot(s)) before this candidate was reached.` });
      continue;
    }

    if (empties > 0) {
      decisions.push({ symbol: cand.symbol, action: 'PROMOTED', score: cand.momentumScore, reason: `Filled an empty streaming slot (${empties} available).` });
      occupied.add(cand.symbol);
      empties -= 1;
      promotedCount += 1;
      continue;
    }

    const dynamicScores = [...dynamicLeft].map((s) => ({ symbol: s, score: opts.scoreOf(s) }));
    if (dynamicScores.length === 0) {
      decisions.push({ symbol: cand.symbol, action: 'NOT_PROMOTED', score: cand.momentumScore, reason: 'No streaming slots available and no non-core dynamic symbol eligible to displace.' });
      continue;
    }
    const weakest = dynamicScores.reduce((min, s) => (s.score < min.score ? s : min));
    if (cand.momentumScore < weakest.score + opts.scoreEdge) {
      decisions.push({
        symbol: cand.symbol, action: 'NOT_PROMOTED', score: cand.momentumScore,
        reason: `Score ${cand.momentumScore.toFixed(3)} does not beat the weakest active dynamic symbol (${weakest.symbol}: ${weakest.score.toFixed(3)}) by the required hysteresis edge (${opts.scoreEdge}) - prevents subscription thrashing.`,
      });
      continue;
    }

    decisions.push({ symbol: cand.symbol, action: 'PROMOTED', score: cand.momentumScore, reason: `Beat weakest active dynamic symbol ${weakest.symbol} (${weakest.score.toFixed(3)}) by more than the hysteresis edge (${opts.scoreEdge}).`, displaces: weakest.symbol });
    occupied.add(cand.symbol);
    dynamicLeft.delete(weakest.symbol);
    occupied.delete(weakest.symbol);
    promotedCount += 1;
  }

  return decisions;
}

/** Real-time capacity/utilization snapshot - no persistence needed, always computed live from
 *  MarketDataWorker's own current state. */
export interface CapacitySnapshot {
  activeCount: number;
  effectiveCap: number;
  utilizationPct: number;
  emptySlots: number;
  coreCount: number;
  dynamicCount: number;
}

export function computeCapacitySnapshot(activeSymbols: string[], coreSymbols: string[], effectiveCap: number): CapacitySnapshot {
  const activeCount = activeSymbols.length;
  const coreCount = coreSymbols.length;
  return {
    activeCount,
    effectiveCap,
    utilizationPct: effectiveCap > 0 ? activeCount / effectiveCap : 0,
    emptySlots: Math.max(0, effectiveCap - activeCount),
    coreCount,
    dynamicCount: Math.max(0, activeCount - coreCount),
  };
}

/**
 * Starvation detection: a symbol whose most recent N composable-ranking cycles all recommended
 * PROMOTE, yet it never appears in the active-symbol set, is starved - a real candidate the
 * priority mechanism is structurally never picking up (as opposed to one that simply hasn't
 * ranked highly enough yet). `recentCycles` should be ordered newest-first per symbol.
 */
export function detectStarvedCandidates(
  recentPromoteRecommendationsBySymbol: Map<string, boolean[]>, // newest-first booleans, true = PROMOTE this cycle
  activeSymbols: Set<string>,
  minConsecutiveCycles: number,
): string[] {
  const starved: string[] = [];
  for (const [symbol, cycles] of recentPromoteRecommendationsBySymbol) {
    if (activeSymbols.has(symbol)) continue;
    let consecutive = 0;
    for (const wasPromote of cycles) {
      if (!wasPromote) break;
      consecutive += 1;
    }
    if (consecutive >= minConsecutiveCycles) starved.push(symbol);
  }
  return starved;
}
