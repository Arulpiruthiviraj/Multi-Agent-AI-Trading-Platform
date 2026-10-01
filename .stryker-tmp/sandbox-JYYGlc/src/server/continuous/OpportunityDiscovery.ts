/**
 * Opportunity discovery loop. Research/ranking + IEX subscribe requests only.
 * Never emits TRADE_IDEA_GENERATED. Never imports OMS / BrokerManager / RiskEngine.
 *
 * During RTH, SnapshotScanner REST-ranks 100+ liquid names every ~30s and hot-swaps
 * non-anchor WebSocket slots via WATCHLIST_SUBSCRIBE_REQUESTED. MarketDataWorker
 * prunes least-scored / least-ticked unprotected symbols so the stream never exceeds
 * MarketDataWorker.getEffectiveStreamingCap() (Alpaca ~12 / IBKR Gateway ~90; anchors locked).
 */
// @ts-nocheck

import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { looksLikeListedTicker } from '../ai/AIOutputValidator';
import { normalizeSymbols } from '../core/symbolNormalization';
import {
  continuousIntelligence,
  isOpportunityLoopEnabled,
} from '../config/continuousIntelligence';
import { isPennyStockEnabled } from '../config/multiAsset';
import { classifyAsset, isPennyOrMicro, type AssetSnapshot } from '../multiAsset/AssetClassifier';
import { evaluateAssetSafety } from '../multiAsset/SafetyFilter';
import { marketDataWorker } from '../services/MarketDataWorker';
import { upsertCandidate, expireStaleCandidates } from './candidateLifecycle';
import { recordCandidate } from '../core/recentCandidateRegistry';
import { tradingSafety } from '../config/tradingSafety';
import { getCachedBroadUniverseCandidatesWithVolume, getCachedBroadUniverseGapPct, getCachedBroadUniverseSnapshotFetchedAt, getCachedMoverSymbols, getCachedNewsCatalystSymbols, marketUniverseScannerWorker } from './MarketUniverseScanner';
import { selectBroadUniverseCandidates } from './BroadUniverseSubscriptionAllocator';
import {
  getLastComposableScore,
  getLastSnapshotScore,
  getTopMomentumCandidates,
  isSnapshotScannerRth,
  type SnapshotCandidate,
} from './SnapshotScanner';
import { explainSnapshotHotSwapDecisions } from './SubscriptionPriorityExplainer';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';

/** Reasons that require a live quote. Watchlist subscribe is allowed; BUY still hits applyAssetIdeaGate. */
const WATCH_ALLOW_UNKNOWN_REASONS = new Set([
  'ASSET_SPREAD_UNKNOWN',
  'ASSET_DOLLAR_VOLUME_UNKNOWN',
  'ASSET_MARKET_ORDER_UNFIT',
]);

export interface OpportunityScanStats {
  ran: boolean;
  skippedOverlap: boolean;
  enabled: boolean;
  scanned: number;
  rejected: number;
  shortlisted: number;
  subscribeRequested: number;
  ideasEmitted: 0;
  rejectedReasons: Record<string, number>;
  shortlist: Array<{ symbol: string; assetClass: string; reason: string }>;
  momentumHotSwap: boolean;
  momentumRanked: number;
  /** 2026-09-29 (discovery-to-evaluation coverage fix): count of broad-universe/mover/news-catalyst
   *  shortlist symbols (outside SnapshotScanner's static momentum universe) scored as hot-swap
   *  challengers this cycle - 0 whenever momentum rotation is off or none had real evidence
   *  (mover-bonus/composable-score/gapPct) to compete on. */
  broadUniverseChallengers: number;
  /** How many of those challengers actually won a hot-swap slot this cycle (subset of
   *  broadUniverseChallengers, bounded by the same existing swap-cap/pacing as momentum-universe
   *  candidates - never additional swap volume). */
  broadUniverseHotSwapWinners: number;
  rth: boolean;
  at: string;
  honesty: string;
}

const EMPTY: OpportunityScanStats = {
  ran: false,
  skippedOverlap: false,
  enabled: false,
  scanned: 0,
  rejected: 0,
  shortlisted: 0,
  subscribeRequested: 0,
  ideasEmitted: 0,
  rejectedReasons: {},
  shortlist: [],
  momentumHotSwap: false,
  momentumRanked: 0,
  broadUniverseChallengers: 0,
  broadUniverseHotSwapWinners: 0,
  rth: false,
  at: new Date(0).toISOString(),
  honesty: continuousIntelligence.honesty,
};

let lastScan: OpportunityScanStats = { ...EMPTY };
let inFlight = false;

function bump(map: Record<string, number>, key: string) {
  map[key] = (map[key] || 0) + 1;
}

export function getLastOpportunityScan(): OpportunityScanStats {
  return lastScan;
}

export function resetOpportunityScanForTests(): void {
  lastScan = { ...EMPTY };
  inFlight = false;
}

export function setOpportunityScanInFlightForTests(value: boolean): void {
  inFlight = value;
}

export function getOpportunityScanUniverse(): string[] {
  // 2026-09-16 subscription-starvation fix: previously `.slice(0, broadUniverseTopNPerScan)` on a
  // list re-sorted by raw dollar volume every call - see BroadUniverseSubscriptionAllocator.ts's own
  // header for the real evidence (five legitimate, liquid movers ranked #99-#622 of 1,418, never once
  // inside the old window). selectBroadUniverseCandidates() replaces the raw slice with a
  // deterministic, aging-aware selection that still favors liquidity but guarantees an eligible
  // candidate cannot be skipped forever. Same admitted-candidate pool, same final cap
  // (broadUniverseTopNPerScan) - only the selection rule inside that cap changed.
  const broadUniverseSelected = selectBroadUniverseCandidates(
    getCachedBroadUniverseCandidatesWithVolume(),
    continuousIntelligence.broadUniverseTopNPerScan,
  ).map((r) => r.symbol);
  const names = [
    ...continuousIntelligence.seedSymbols,
    ...continuousIntelligence.watchUniverseSymbols,
    ...continuousIntelligence.momentumScanUniverseSymbols,
    ...broadUniverseSelected,
    // Phase 17 (2026-09-01): real Alpaca top-gainers/losers, already liquidity/ADV-screened by
    // MarketUniverseScanner.refreshMoversCache() - same evaluateOpportunityCandidate() gate below,
    // never a trade by itself.
    ...getCachedMoverSymbols().slice(0, continuousIntelligence.moversTopNPerScan),
    // 2026-09-10 (postmarket-audit follow-up): real, reviewed-catalyst symbols from
    // MarketUniverseScanner.refreshNewsCatalystCache() - already liquidity/ADV-screened the same
    // way, closes the confirmed live gap where a genuine news catalyst (SEI) never became a
    // discovery candidate because no agent had independently looked it up first.
    ...getCachedNewsCatalystSymbols().slice(0, continuousIntelligence.newsCatalystDiscoveryTopNPerScan),
  ];
  if (isPennyStockEnabled()) {
    names.push(...continuousIntelligence.pennyWatchSymbols);
  }
  return normalizeSymbols(names);
}

export function evaluateOpportunityCandidate(
  raw: string,
  snapshot: Partial<AssetSnapshot> = {},
  purpose: 'watch' | 'trade' = 'watch',
): { action: 'reject' | 'shortlist'; symbol: string | null; reason: string; assetClass?: string } {
  const symbol = looksLikeListedTicker(raw);
  if (!symbol) {
    return { action: 'reject', symbol: null, reason: 'INVALID_SYMBOL' };
  }
  const classification = classifyAsset({ symbol, ...snapshot });
  if (isPennyStockEnabled() && isPennyOrMicro(classification.assetClass)) {
    const safety = evaluateAssetSafety({ symbol, ...snapshot }, classification);
    if (safety.verdict === 'BLOCK') {
      const hard = purpose === 'watch'
        ? safety.reasons.filter((r) => !WATCH_ALLOW_UNKNOWN_REASONS.has(r))
        : safety.reasons;
      if (hard.length > 0) {
        return {
          action: 'reject',
          symbol,
          reason: hard[0] || 'ASSET_CLASS_BLOCKED',
          assetClass: classification.assetClass,
        };
      }
    }
  }
  return {
    action: 'shortlist',
    symbol,
    reason: purpose === 'watch' ? 'watch_candidate' : 'trade_candidate',
    assetClass: classification.assetClass,
  };
}

/**
 * Phase 3 (Dynamic Market Data Allocation, 2026-09-02 forensic-audit follow-up). Before this, the
 * hot-swap priority ranking (planSnapshotHotSwap, below) only ever used SnapshotScanner's own
 * intraday momentum recompute - a real signal, but entirely disconnected from the SEPARATE real
 * external mover signal MarketUniverseScanner's movers funnel already computes (real Alpaca top-
 * gainers/losers, liquidity-screened). This blends both real signals into one priority score
 * instead of letting the two discovery mechanisms compete blindly for the same scarce
 * subscription/rescue capacity: a symbol the movers funnel has already verified as a real,
 * currently-admitted mover gets a real, configured priority bonus on top of its own momentum score.
 * Uses only the already-computed, already-cached `getCachedMoverSymbols()` list - no new DB query,
 * no new API call, no new cache.
 *
 * Universal Opportunity Discovery follow-up (2026-09-03): also blends in ComposableRanking's own
 * persisted finalScore (getLastComposableScore()) when available for this symbol this cycle. Real
 * gap found by direct source inspection: runRankingCycle()'s 7-component, evidence-aware score
 * (momentum + relativeVolume + rangeExpansion + gap + liquidity + newsCatalyst + agentConfidence,
 * each explicitly AVAILABLE/UNAVAILABLE rather than silently zeroed) already runs every cycle and
 * is already persisted to candidate_rankings, but until this change had ZERO path into any actual
 * subscription/eviction decision - it only ever fed TradePlanBuilder (premarket drafts) and
 * MissedOpportunityDetector (post-hoc classification). A candidate with strong gap/liquidity/news/
 * agent-confidence evidence but modest raw momentum could rank #1 on the composable score and still
 * never receive a market-data slot. Additive and zero when unavailable (never fabricated as 0-as-
 * penalty), matching the moverPriorityScoreBonus pattern above.
 */
export function blendedHotSwapScore(sym: string, baseScoreOf: (symbol: string) => number): number {
  const base = baseScoreOf(sym);
  const isVerifiedMover = getCachedMoverSymbols().includes(sym.toUpperCase());
  const withMoverBonus = isVerifiedMover ? base + continuousIntelligence.moverPriorityScoreBonus : base;
  const composableScore = getLastComposableScore(sym);
  return composableScore != null
    ? withMoverBonus + (composableScore * continuousIntelligence.composableRankingHotSwapWeight)
    : withMoverBonus;
}

/**
 * 2026-09-29 (discovery-to-evaluation coverage fix, docs/audits/archive/
 * ARGUS_MIDDAY_ZERO_TRADE_2026-09-29.md). Real, confirmed gap: `top` (SnapshotScanner's static
 * momentum universe) was the ONLY source of hot-swap challengers when the stream is full - a
 * broad-universe-only admission (never part of that static universe, e.g. IOVA) had zero
 * momentum/mover/composable signal via blendedHotSwapScore() because `baseScoreOf` only ever
 * looks up getLastSnapshotScore()/getDynamicMomentumScore(), both scoped to symbols SnapshotScanner
 * or MarketDataWorker have actually scored - a broad-universe-only symbol returns 0 from both.
 *
 * This scores such a symbol using the SAME blendedHotSwapScore() (so a real mover-bonus or
 * composable-ranking score still counts, when present), PLUS a real, already-fetched gap term
 * (|gapPct| * 100, percent units matching SnapshotScanner's own SCORE_WEIGHT_PCT convention,
 * weighted by broadUniverseGapHotSwapWeight) - a broad-universe symbol with a genuine intraday
 * move can now compete on that evidence alone, never fabricated when gapPct is null (contributes
 * exactly 0, not treated as "no move").
 */
export function scoreBroadUniverseChallenger(
  sym: string,
  gapPct: number | null,
  baseScoreOf: (symbol: string) => number,
): number {
  const blended = blendedHotSwapScore(sym, baseScoreOf);
  const gapTerm = gapPct != null && Number.isFinite(gapPct)
    ? Math.abs(gapPct) * 100 * continuousIntelligence.broadUniverseGapHotSwapWeight
    : 0;
  return blended + gapTerm;
}

function weakestDynamicScore(
  activeDynamic: string[],
  scoreOf: (symbol: string) => number,
): { symbol: string; score: number } | null {
  if (activeDynamic.length === 0) return null;
  let worst: { symbol: string; score: number } | null = null;
  for (const sym of activeDynamic) {
    const score = scoreOf(sym);
    if (!worst || score < worst.score) worst = { symbol: sym, score };
  }
  return worst;
}

/**
 * Rebalance dynamic slots toward SnapshotScanner top movers.
 * Returns symbols to subscribe (MDW prunes when at cap).
 * When the stream is full (emptySlots === 0), at most **1** replacement is planned
 * regardless of a higher maxSwaps — prevents intra-cycle thrash.
 */
export function planSnapshotHotSwap(opts: {
  top: SnapshotCandidate[];
  active: Set<string>;
  activeDynamic: string[];
  emptySlots: number;
  maxSwaps: number;
  scoreEdge: number;
  scoreOf: (symbol: string) => number;
}): string[] {
  const toRequest: string[] = [];
  const occupied = new Set(opts.active);
  let empties = opts.emptySlots;
  const dynamicLeft = new Set(opts.activeDynamic);
  const swapCap = opts.emptySlots > 0
    ? Math.max(0, opts.maxSwaps)
    : Math.min(1, Math.max(0, opts.maxSwaps));

  for (const cand of opts.top) {
    if (toRequest.length >= swapCap) break;
    if (occupied.has(cand.symbol)) continue;

    if (empties > 0) {
      toRequest.push(cand.symbol);
      occupied.add(cand.symbol);
      empties -= 1;
      continue;
    }

    const weakest = weakestDynamicScore([...dynamicLeft], opts.scoreOf);
    if (!weakest) break;
    if (cand.momentumScore < weakest.score + opts.scoreEdge) continue;

    toRequest.push(cand.symbol);
    occupied.add(cand.symbol);
    dynamicLeft.delete(weakest.symbol);
    occupied.delete(weakest.symbol);
  }
  return toRequest;
}

export async function runOpportunityScan(now: Date = new Date()): Promise<OpportunityScanStats> {
  try {
    const { runCampaignOpeningSurge } = await import('../services/CampaignOpeningSurge');
    void runCampaignOpeningSurge(now);
  } catch {
    /* optional */
  }
  if (!isOpportunityLoopEnabled()) {
    lastScan = { ...EMPTY, enabled: false, at: new Date().toISOString(), ran: false };
    return lastScan;
  }
  if (inFlight) {
    lastScan = { ...lastScan, skippedOverlap: true, enabled: true };
    return lastScan;
  }
  inFlight = true;
  // Phase 9 (time-bounded evaluation window): a candidate this scan does not re-shortlist this
  // cycle ages out of DISCOVERED/WATCHING into STALE rather than sitting at its last real state
  // forever. Reuses recentCandidatePriorityMaxAgeMs (the same "still worth prioritizing" window
  // recentCandidateRegistry.ts already uses) rather than inventing a new number. Observability
  // only - never touches consensus/RiskEngine/OMS.
  try {
    expireStaleCandidates(tradingSafety.recentCandidatePriorityMaxAgeMs, now.getTime());
  } catch (e) {
    console.error('[OpportunityDiscovery] expireStaleCandidates failed (does not affect the real scan)', e);
  }
  const rejectedReasons: Record<string, number> = {};
  const shortlist: OpportunityScanStats['shortlist'] = [];
  const rth = isSnapshotScannerRth(now);
  let momentumHotSwap = false;
  let momentumRanked = 0;
  let broadUniverseChallengerCount = 0;
  let broadUniverseHotSwapWinnerCount = 0;
  /** Symbols this cycle's toRequest won via the NEW broad-universe hot-swap challenger path
   *  (as opposed to the momentum universe or the existing empty-slot topup) - read by the
   *  WATCHLIST_SUBSCRIBE_REQUESTED reason tagging below, outside the momentum-rotation branch. */
  const broadUniverseHotSwapWinnerSymbols = new Set<string>();
  /** 2026-09-29 correction: real priorityScoreOf() value per symbol this cycle, populated by
   *  whichever branch actually computed one (combinedTop and/or topUpFromBroadUniverse below) -
   *  read at the WATCHLIST_SUBSCRIBE_REQUESTED emission loop so the score that decided admission
   *  is the SAME score that seeds MarketDataWorker's real eviction-priority store, instead of the
   *  emission loop re-deriving (and losing) it via getLastSnapshotScore() alone. Per-cycle,
   *  discarded after use - not a new persistent scoring store. */
  const candidatePriorityScores = new Map<string, number>();
  try {
    const active = new Set(marketDataWorker.getActiveSymbols().map((s) => s.toUpperCase()));
    const universe = getOpportunityScanUniverse();
    let rejected = 0;
    for (const raw of universe) {
      const verdict = evaluateOpportunityCandidate(raw, {}, 'watch');
      if (verdict.action === 'reject' || !verdict.symbol) {
        rejected += 1;
        bump(rejectedReasons, verdict.reason);
        continue;
      }
      shortlist.push({
        symbol: verdict.symbol,
        assetClass: verdict.assetClass || 'UNKNOWN',
        reason: active.has(verdict.symbol) ? 'already_subscribed' : verdict.reason,
      });
    }

    // Planner cap follows MarketDataWorker (IBKR hardCap ~90; Alpaca default ~12).
    const cap = marketDataWorker.getEffectiveStreamingCap();
    const emptySlots = Math.max(0, cap - active.size);
    let toRequest: string[] = [];
    // 2026-09-29 correction (second Codex review, item 4): baseScoreOf must NEVER fall back to
    // marketDataWorker.getDynamicMomentumScore(s). That map stores this cycle's FINAL priority
    // (priorityScoreOf's own output: base + mover-bonus + composable*weight + gap*weight),
    // written by the emission loop below via candidatePriorityScores. A prior version of this
    // function fell back to that same stored value as a "base" whenever getLastSnapshotScore(s)
    // was null (true for every broad-universe-only symbol, since SnapshotScanner never scans
    // outside its own seed/watch/momentum universe) - so a broad-universe symbol admitted in cycle
    // N had its already-bonused final priority read back as cycle N+1's "raw" base, and
    // mover-bonus/composable/gap were added AGAIN on top of a number that already included them.
    // getLastSnapshotScore(s) ?? 0 is the only real, non-compounding raw signal: SnapshotScanner's
    // own fresh per-cycle recompute for symbols it scans, or a genuine "no fresh momentum evidence"
    // 0 for a broad-universe-only symbol (which can still compete purely on mover-bonus/composable/
    // gap - never fabricated, never inflated by its own prior score).
    const baseScoreOf = (s: string) => getLastSnapshotScore(s) ?? 0;
    // 2026-09-29 correction (Codex review of the same-day fix): the ONE documented, comparable
    // priority function for this whole cycle - applied identically to momentum-universe AND
    // broad-universe candidates (both inside the hot-swap branch below AND the separate
    // topUpFromBroadUniverse block), so a candidate's source never by itself decides array
    // position or its stored eviction-priority score. Momentum candidates were previously compared
    // on raw SnapshotScanner momentumScore while broad-universe challengers were compared on this
    // blended score - genuinely different scales, silently favoring whichever pool happened to
    // sort first. Unifying to one function is strictly additive for momentum candidates
    // (blendedHotSwapScore/gap terms are non-negative) and makes every subsequent comparison,
    // sort, and stored eviction score apples-to-apples. Because baseScoreOf (above) is now always a
    // fresh, non-compounding signal, priorityScoreOf is now also safe to use for INCUMBENT scoring
    // (the scoreOf callback below) with no double-counting risk - see that callback's own comment.
    const priorityScoreOf = (symbol: string): number =>
      scoreBroadUniverseChallenger(symbol, getCachedBroadUniverseGapPct(symbol), baseScoreOf);

    if (continuousIntelligence.momentumRotationEnabled) {
      const top = await getTopMomentumCandidates(continuousIntelligence.snapshotTopCandidates, { now });
      momentumRanked = top.length;
      // 2026-09-30 (IOVA request-to-evaluation gap, docs/audits/archive/
      // ARGUS_FULL_SESSION_REVIEW_2026-09-29.md): real, verified eligibility mismatch - the raw
      // getDynamicSymbols() superset includes dwell-protected and active-rescue symbols this
      // worker's own rankEvictionCandidates()/pruneLeastActiveWatchSymbols() would refuse to evict.
      // Planning a hot-swap against that superset let this planner "win" a swap by naming a
      // never-actually-evictable incumbent as the weakest, so the challenger's own subscribe()
      // request then hit a silent capacity refusal at execution time with nothing evicted -
      // exactly IOVA's observed pattern (repeated BROAD_UNIVERSE_HOT_SWAP requests, never
      // resolved). getEvictionEligibleDynamicSymbols() reuses MarketDataWorker's own canonical
      // eviction ranking, so planning and actual eviction now always agree - when zero incumbents
      // are genuinely evictable (e.g. all held by real dwell/rescue protection), this correctly
      // narrows to an empty pool and plans no swap at all this cycle, rather than repeatedly
      // planning one the worker cannot fulfill.
      const activeDynamic = marketDataWorker.getEvictionEligibleDynamicSymbols();
      // Fill empty slots up to maxNewSubscriptionsPerCycle; when full, hot-swap at most 1.
      const maxSwaps = emptySlots > 0
        ? Math.min(continuousIntelligence.maxNewSubscriptionsPerCycle, emptySlots)
        : Math.min(continuousIntelligence.momentumHotSwapSlotsPerCycle, 1);

      // 2026-09-29 (discovery-to-evaluation coverage fix): broad-universe/mover/news-catalyst
      // shortlist symbols NOT already in the momentum `top` list get a real chance to compete for
      // an OCCUPIED slot too - previously only `top` (SnapshotScanner's static universe) could ever
      // challenge at full capacity; a broad-universe-only admission (e.g. IOVA) could only ever fill
      // an EMPTY slot (see topUpFromBroadUniverse below), never displace an occupant. Scored via
      // priorityScoreOf() (real mover-bonus/composable-score/gapPct evidence only - never a bare
      // admission), bounded by broadUniverseHotSwapChallengerLimit so this stays a cost-controlled
      // top-N, not every admitted symbol every cycle.
      const topSymbols = new Set(top.map((c) => c.symbol));
      // 2026-09-30 (Discovery Challenger Observability Hardening,
      // ARGUS_CHALLENGER_SELECTION_FORENSIC_2026-09-29.md §1/§3): priorityScoreBreakdownOf's
      // finalScore field is priorityScoreOf(symbol) itself - the SAME already-defined closure every
      // other branch of this cycle (rankedTop, scoreOf callbacks, topUp) calls - never a second,
      // independently-invoked computation, so there is no way for this observability breakdown to
      // disagree with the real decision. baseScore/gapPct/hasGapEvidence are the real inputs
      // priorityScoreOf() itself reads. gapTerm mirrors scoreBroadUniverseChallenger()'s own
      // one-line internal formula for display only - it is never itself used to derive finalScore,
      // so a future change to that formula cannot silently desync the REAL decision from what gets
      // logged (only this display mirror would need updating, and staleness there is a
      // documentation gap, not a decision-path divergence).
      const priorityScoreBreakdownOf = (symbol: string): {
        finalScore: number; baseScore: number; gapPct: number | null; gapTerm: number; hasGapEvidence: boolean;
      } => {
        const gapPct = getCachedBroadUniverseGapPct(symbol);
        const baseScore = baseScoreOf(symbol);
        const finalScore = priorityScoreOf(symbol);
        const gapTerm = gapPct != null && Number.isFinite(gapPct)
          ? Math.abs(gapPct) * 100 * continuousIntelligence.broadUniverseGapHotSwapWeight
          : 0;
        return { finalScore, baseScore, gapPct, gapTerm, hasGapEvidence: gapPct != null };
      };
      // 2026-09-30: discoverySource is a best-effort label inferred from which real, already-cached
      // admission list currently contains this symbol - shortlist rows themselves carry no source
      // tag today (a larger, separate change to getOpportunityScanUniverse() this pass does not
      // make), so this can misattribute a symbol admitted via more than one mechanism this cycle to
      // whichever check runs first below. Observability-only; never used in any real decision.
      const cachedBroadUniverseSymbols = new Set(getCachedBroadUniverseCandidatesWithVolume().map((c) => c.symbol));
      const cachedMoverSymbols = new Set(getCachedMoverSymbols());
      const cachedNewsCatalystSymbols = new Set(getCachedNewsCatalystSymbols());
      const inferredDiscoverySourceOf = (symbol: string): string => {
        if (cachedBroadUniverseSymbols.has(symbol)) return 'BROAD_UNIVERSE';
        if (cachedMoverSymbols.has(symbol)) return 'MARKET_MOVER';
        if (cachedNewsCatalystSymbols.has(symbol)) return 'NEWS_CATALYST';
        return 'SEED_OR_WATCH_OR_UNKNOWN';
      };

      const broadUniverseEligibleWithBreakdown = shortlist
        .filter((row) => !active.has(row.symbol) && !topSymbols.has(row.symbol))
        .map((row) => ({ symbol: row.symbol, breakdown: priorityScoreBreakdownOf(row.symbol) }))
        .filter((c) => c.breakdown.finalScore > 0)
        .sort((a, b) => b.breakdown.finalScore - a.breakdown.finalScore);
      const zeroOrExcludedCandidateCount = shortlist.filter((row) => !active.has(row.symbol) && !topSymbols.has(row.symbol)).length
        - broadUniverseEligibleWithBreakdown.length;
      const challengerLimit = continuousIntelligence.broadUniverseHotSwapChallengerLimit;
      const broadUniverseChallengers: SnapshotCandidate[] = broadUniverseEligibleWithBreakdown
        .slice(0, challengerLimit)
        .map((c) => ({
          symbol: c.symbol,
          intradayPctChange: 0,
          rangeExpansion: 0,
          relativeVolume: 0,
          momentumScore: c.breakdown.finalScore,
        }));
      const broadUniverseChallengerSymbols = new Set(broadUniverseChallengers.map((c) => c.symbol));
      // Shared across the pre-truncation snapshot below and the post-planning swap-outcome summary
      // further down, so both events correlate to the same cycle and the same budget numbers.
      const cycleId = `cycle_${now.getTime()}`;
      // Mirrors planSnapshotHotSwap()'s own internal swapCap clamp (a trivial, one-line formula,
      // not decision logic prone to drift) so the budget this logs matches what that function
      // actually enforces, without changing planSnapshotHotSwap()'s signature to return it.
      const effectiveSwapBudget = emptySlots > 0 ? Math.max(0, maxSwaps) : Math.min(1, Math.max(0, maxSwaps));

      // §1/§4/§7: one bounded per-cycle snapshot (never unbounded per-candidate events) - the
      // pre-truncation candidate pool, capped at 2x the real challenger limit ("top N + cutoff
      // neighborhood" per the mandate's own fallback design), plus aggregate counts for everything
      // outside that bound. This is what makes a BELOW_CHALLENGER_LIMIT vs ZERO_SCORE exclusion
      // provable after the fact - explainSnapshotHotSwapDecisions() below only ever sees the
      // post-truncation broadUniverseChallengers list, so a candidate excluded here left no record
      // at all before this change.
      try {
        // §7 (bound the data volume): config/observability.json's maxPayloadChars (8000) truncates
        // an over-length JSON payload mid-string, which would otherwise corrupt this event's stored
        // payload for the CLI report (§8) to parse. Real, full-precision JS floats (e.g. 0.0523 can
        // serialize as "0.05230000000000004") make an untrimmed candidate array's actual length
        // unpredictable, so both the array bound (challengerLimit + 5, a realistic top-N + cutoff
        // neighborhood - never unbounded) and each numeric field (rounded to 4 decimal places,
        // display-only, never fed back into any real comparison) are kept conservative.
        const detailBound = Math.min(broadUniverseEligibleWithBreakdown.length, challengerLimit + 5);
        const round4 = (n: number): number => Math.round(n * 10000) / 10000;
        const snapshotFetchedAt = getCachedBroadUniverseSnapshotFetchedAt();
        observeSafe(() => {
          structuredLogger.info('discovery_challenger_cycle_snapshot', {
            category: 'DISCOVERY',
            eventType: 'DISCOVERY_CHALLENGER_CYCLE_SNAPSHOT',
            reasoning: `cycleId=${cycleId} eligible=${broadUniverseEligibleWithBreakdown.length} `
              + `survivedTruncation=${broadUniverseChallengers.length} zeroOrExcluded=${zeroOrExcludedCandidateCount} `
              + `challengerLimit=${challengerLimit}`,
            // Aggregate counts - always present, cheap, covers every candidate this cycle.
            cycleId,
            totalShortlisted: shortlist.length,
            eligibleForChallengerScoring: broadUniverseEligibleWithBreakdown.length,
            zeroScoreOrExcludedCount: zeroOrExcludedCandidateCount,
            challengerLimit,
            survivedTruncationCount: broadUniverseChallengers.length,
            // Hot-swap budget state (§5) - real values from THIS cycle's own already-computed
            // emptySlots/maxSwaps, not re-derived.
            activeSubscriptionCount: active.size,
            maxActiveSubscriptions: cap,
            emptySlots,
            maxSwapsRequested: maxSwaps,
            effectiveSwapBudget,
            // Bounded per-candidate detail - top N plus cutoff-neighborhood, real values only.
            candidates: broadUniverseEligibleWithBreakdown.slice(0, detailBound).map((c, i) => ({
              symbol: c.symbol,
              discoverySource: inferredDiscoverySourceOf(c.symbol),
              baseScore: round4(c.breakdown.baseScore),
              gapPct: c.breakdown.gapPct != null ? round4(c.breakdown.gapPct) : null,
              gapTerm: round4(c.breakdown.gapTerm),
              finalPriorityScore: round4(c.breakdown.finalScore),
              hasGapEvidence: c.breakdown.hasGapEvidence,
              gapEvidenceAgeMs: c.breakdown.hasGapEvidence && snapshotFetchedAt != null ? Math.max(0, now.getTime() - snapshotFetchedAt) : null,
              rankBeforeTruncation: i + 1,
              survivedTruncation: i < challengerLimit,
            })),
          });
        });
      } catch (e) {
        console.error('[OpportunityDiscovery] Challenger cycle snapshot logging failed (observability only, does not affect the real hot-swap decision)', e);
      }

      // 2026-09-29 correction: remap `top`'s own momentumScore through the SAME priorityScoreOf()
      // before merging, then sort the COMBINED pool once by that single comparable score
      // (deterministic alphabetical tiebreak). Real defect this closes: `combinedTop =
      // [...top, ...broadUniverseChallengers]` (unsorted) let planSnapshotHotSwap's array-order
      // iteration hand the one-slot swap budget to whichever momentum candidate came first in
      // `top`, even when a much stronger broad-universe challenger was also present - source
      // determined priority, not score. The prior IOVA-class test masked this by emptying `top`
      // entirely; it never exercised the case where both pools are non-empty.
      const rankedTop: SnapshotCandidate[] = top.map((c) => ({ ...c, momentumScore: priorityScoreOf(c.symbol) }));
      const combinedTop = [...rankedTop, ...broadUniverseChallengers]
        .sort((a, b) => b.momentumScore - a.momentumScore || a.symbol.localeCompare(b.symbol));
      // 2026-09-29 correction: the SAME score that decided selection must be what gets stored as
      // this symbol's ongoing eviction priority (MarketDataWorker.dynamicMomentumScores) - real
      // defect this closes: the subscription-request emission below previously re-derived score via
      // getLastSnapshotScore(symbol) alone, which is null/undefined for any broad-universe-only
      // symbol. MarketDataWorker.subscribe() then never calls dynamicMomentumScores.set() for that
      // symbol (the `typeof === 'number'` guard fails on undefined), so rankEvictionCandidates()
      // reads it back as 0 - the worst possible score - on the very next prune, regardless of the
      // real evidence that won it the slot in the first place. This map is NOT a second persistent
      // scoring store: it is a per-cycle, discarded-after-use lookup that ensures the ALREADY
      // existing canonical store (dynamicMomentumScores) gets seeded with the real value instead of
      // silently dropping to undefined.
      for (const c of combinedTop) candidatePriorityScores.set(c.symbol, c.momentumScore);

      // 2026-09-29 correction (second Codex review, item 4): scoreOf ranks the weakest ACTIVE
      // incumbent for eviction comparison against combinedTop's challengers - it must use the SAME
      // priorityScoreOf() challengers are ranked and sorted with above (momentumScore on
      // rankedTop/broadUniverseChallengers), not blendedHotSwapScore() alone. The prior asymmetry
      // meant an incumbent's gap-term evidence was silently excluded from its own eviction-risk
      // score while an otherwise-identical challenger's gap term counted in full - a real,
      // source-dependent scoring bias, not just a challenger-side gap. Safe to unify now that
      // baseScoreOf (above) never reads back an already-bonused stored value.
      const planned = planSnapshotHotSwap({
        top: combinedTop,
        active,
        activeDynamic,
        emptySlots,
        maxSwaps,
        scoreEdge: continuousIntelligence.snapshotMomentumScoreEdge,
        scoreOf: (sym) => priorityScoreOf(sym),
      });
      toRequest = planned;
      momentumHotSwap = planned.length > 0 && (emptySlots === 0 || rth);
      const broadUniverseHotSwapWinners = new Set(planned.filter((s) => broadUniverseChallengerSymbols.has(s)));
      for (const s of broadUniverseHotSwapWinners) broadUniverseHotSwapWinnerSymbols.add(s);

      // §5: swap-budget outcome for this cycle, correlated to the pre-truncation snapshot above via
      // cycleId. planned.length is the real, already-computed number of swaps planSnapshotHotSwap()
      // actually returned - never re-derived or estimated.
      try {
        const swapsConsumed = planned.length;
        observeSafe(() => {
          structuredLogger.info('discovery_challenger_swap_outcome', {
            category: 'DISCOVERY',
            eventType: 'DISCOVERY_CHALLENGER_SWAP_OUTCOME',
            reasoning: `cycleId=${cycleId} swapsConsumed=${swapsConsumed} of effectiveSwapBudget=${effectiveSwapBudget}`,
            cycleId,
            activeSubscriptionCount: active.size,
            maxActiveSubscriptions: cap,
            emptySlots,
            maxSwapsRequested: maxSwaps,
            effectiveSwapBudget,
            swapsConsumed,
            swapsRemaining: Math.max(0, effectiveSwapBudget - swapsConsumed),
          });
        });
      } catch (e) {
        console.error('[OpportunityDiscovery] Swap-outcome logging failed (observability only, does not affect the real hot-swap decision)', e);
      }

      // Phase 4D (Dynamic Subscription Priority Queue, 2026-08-26): recomputes the IDENTICAL
      // decision rule planSnapshotHotSwap already applied above, purely to explain every
      // candidate's outcome (PROMOTED/NOT_PROMOTED/ALREADY_ACTIVE + reason). Never changes
      // `toRequest`/`momentumHotSwap` above - additive telemetry only, wrapped so it can never
      // affect the real subscribe decision. Now also covers broadUniverseChallengers (combinedTop),
      // so an operator can see why an admitted broad-universe symbol was or was not promoted, not
      // just momentum-universe ones.
      try {
        // Same scoreOf unification as planSnapshotHotSwap above - this explainer recomputes the
        // IDENTICAL decision rule purely for observability, so it must use the same priorityScoreOf
        // basis or its PROMOTED/NOT_PROMOTED explanations would silently diverge from the real
        // decision they claim to explain.
        const decisions = explainSnapshotHotSwapDecisions({
          top: combinedTop, active, activeDynamic,
          emptySlots,
          maxSwaps: emptySlots > 0 ? Math.min(continuousIntelligence.maxNewSubscriptionsPerCycle, emptySlots) : Math.min(continuousIntelligence.momentumHotSwapSlotsPerCycle, 1),
          scoreEdge: continuousIntelligence.snapshotMomentumScoreEdge,
          scoreOf: (sym) => priorityScoreOf(sym),
        });
        // §2: map the explainer's own free-text action/reason onto the mandate's canonical
        // taxonomy (ZERO_SCORE, BELOW_CHALLENGER_LIMIT, CHALLENGER_SELECTED, SWAP_CAP_REACHED,
        // INCUMBENT_NOT_EVICTABLE, COOLDOWN, ALREADY_ACTIVE, ALREADY_PENDING, DUPLICATE, OTHER) -
        // reuses the explainer's existing reason strings verbatim rather than adding a second,
        // parallel decision mechanism. ZERO_SCORE/BELOW_CHALLENGER_LIMIT never appear here because
        // a candidate with a zero score or truncated out never reaches explainSnapshotHotSwapDecisions
        // at all - those two outcomes are covered by the discovery_challenger_cycle_snapshot event
        // above instead (aggregate zeroScoreOrExcludedCount / per-candidate survivedTruncation:false).
        const reasonCodeOf = (d: { action: string; reason: string }): string => {
          if (d.action === 'ALREADY_ACTIVE') return 'ALREADY_ACTIVE';
          if (d.action === 'PROMOTED') return 'CHALLENGER_SELECTED';
          if (d.reason.startsWith('Hot-swap cap reached')) return 'SWAP_CAP_REACHED';
          if (d.reason.startsWith('No streaming slots available and no non-core dynamic symbol eligible')) return 'INCUMBENT_NOT_EVICTABLE';
          return 'OTHER';
        };
        for (const d of decisions) {
          const reasonCode = reasonCodeOf(d);
          observeSafe(() => {
            structuredLogger.info('subscription_priority_decision', {
              category: 'DISCOVERY',
              eventType: `SUBSCRIPTION_${d.action}`,
              symbol: d.symbol,
              reasoning: d.reason,
              reasonCode,
              source: broadUniverseChallengerSymbols.has(d.symbol) ? 'BROAD_UNIVERSE_CHALLENGER' : 'MOMENTUM_UNIVERSE',
              // §5: promotion/displacement detail - only meaningful (and only present) when this
              // decision actually displaced an incumbent (d.displaces is set by the explainer only
              // for that exact branch).
              ...(d.displaces ? {
                promotedSymbol: d.symbol,
                displacedSymbol: d.displaces,
                challengerScore: d.score,
                // d.displaces names an ACTIVE incumbent being evicted, not a combinedTop candidate,
                // so it never appears in `decisions` itself - priorityScoreOf(d.displaces) is the
                // same scoring function the explainer itself used (via its own scoreOf callback) to
                // rank that incumbent, called again here only to surface it in this log line.
                incumbentScore: priorityScoreOf(d.displaces),
              } : {}),
            });
          });
        }
      } catch (e) {
        console.error('[OpportunityDiscovery] Subscription priority explainer failed (does not affect the real hot-swap decision)', e);
      }
      broadUniverseChallengerCount = broadUniverseChallengers.length;
      broadUniverseHotSwapWinnerCount = broadUniverseHotSwapWinners.size;
    } else if (emptySlots > 0) {
      toRequest = shortlist
        .filter((row) => !active.has(row.symbol))
        .slice(0, Math.min(continuousIntelligence.maxNewSubscriptionsPerCycle, emptySlots))
        .map((r) => r.symbol);
    }

    // Real gap found live (2026-09-16, post-SIP-ADV-fix universe-construction follow-up): when
    // momentumRotationEnabled is true, toRequest above is sourced entirely from
    // getTopMomentumCandidates() -> SnapshotScanner.ts's getSnapshotScanUniverse(), which only ever
    // scans continuousIntelligence.seedSymbols/watchUniverseSymbols/campaignOpeningSurgeSymbols/
    // momentumScanUniverseSymbols - a small, static, curated list. It never reads
    // getCachedBroadUniverseSymbols() (the ADV-gated broad-universe discovery admission list feeding
    // `shortlist` above), even though that list is already computed this same cycle. Confirmed live:
    // the SIP ADV fix took broad-universe admission from 17 to 192 symbols same-day, but 0 of those
    // 192 ever received a subscribe request, because admission to `shortlist` was never connected to
    // `toRequest` while momentum rotation is on - only used for the candidate ledger (upsertCandidate
    // below). This top-up spends only genuinely LEFTOVER empty capacity momentum rotation's own
    // top-N (snapshotTopCandidates) picks didn't claim - it never reorders or competes with momentum
    // rotation's own picks, never touches momentumHotSwap's own slot math above, and is a no-op
    // whenever momentum rotation already used every available slot this cycle (e.g. already at cap).
    const topUpFromBroadUniverse = new Set<string>();
    if (continuousIntelligence.momentumRotationEnabled) {
      const alreadyRequested = new Set(toRequest);
      const capForCycle = emptySlots > 0 ? Math.min(continuousIntelligence.maxNewSubscriptionsPerCycle, emptySlots) : 0;
      const remaining = Math.max(0, capForCycle - toRequest.length);
      if (remaining > 0) {
        const topUp = shortlist
          .filter((row) => !active.has(row.symbol) && !alreadyRequested.has(row.symbol))
          .slice(0, remaining)
          .map((r) => r.symbol);
        for (const symbol of topUp) {
          topUpFromBroadUniverse.add(symbol);
          // 2026-09-29 correction: same score-propagation fix as the hot-swap path above - a
          // topUp symbol's real priorityScoreOf() (not getLastSnapshotScore(), which is null for
          // most broad-universe-only symbols) must reach MarketDataWorker.dynamicMomentumScores,
          // or it is silently treated as the worst-ranked active symbol on the next eviction pass.
          if (!candidatePriorityScores.has(symbol)) candidatePriorityScores.set(symbol, priorityScoreOf(symbol));
        }
        toRequest = toRequest.concat(topUp);
      }
    }

    for (const row of shortlist) {
      upsertCandidate({
        symbol: row.symbol,
        state: active.has(row.symbol) ? 'WATCHING' : 'DISCOVERED',
        assetClass: row.assetClass,
        reason: row.reason,
      });
    }

    for (const symbol of toRequest) {
      // 2026-09-29 correction: prefer the real score that actually decided this cycle's selection
      // (candidatePriorityScores, populated above for every hot-swap/topUp candidate) over
      // re-deriving from getLastSnapshotScore() alone - the latter is null/undefined for any
      // broad-universe-only symbol and silently loses real evidence at exactly the point
      // MarketDataWorker.subscribe() needs it to seed dynamicMomentumScores. Falls back to
      // getLastSnapshotScore() only for a symbol this cycle never scored (the non-momentum-rotation
      // branch, or a momentum-universe symbol requested via some other future path).
      const score = candidatePriorityScores.get(symbol) ?? getLastSnapshotScore(symbol) ?? undefined;
      eventBus.emit(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, {
        symbol,
        source: 'OpportunityDiscovery',
        reason: topUpFromBroadUniverse.has(symbol)
          ? 'BROAD_UNIVERSE_TOPUP'
          : broadUniverseHotSwapWinnerSymbols.has(symbol)
          ? 'BROAD_UNIVERSE_HOT_SWAP'
          : (momentumHotSwap ? 'SNAPSHOT_HOT_SWAP' : 'SEED_UNIVERSE_EXPANSION'),
        momentumScore: score,
        honesty: 'Subscribe request only — not a trade idea and not an order.',
      });
      // Phase 9 (same-candidate convergence, third real source): a real, momentum-ranked
      // subscribe request is exactly the kind of "worth a look" signal ConfluenceCoordinator/
      // QuantSignalAgent already register - bridging it here lets other agents' own priority
      // round-robins (see recentCandidateRegistry.ts's callers) converge toward the broad-
      // universe discovery system's own real ranking too, not only reactive signals. Still
      // never a vote, never an idea, never touches OMS/RiskEngine/broker - a pure in-memory
      // registry write, and this file still imports none of the agent-specific modules.
      recordCandidate(symbol);
    }

    lastScan = {
      ran: true,
      skippedOverlap: false,
      enabled: true,
      scanned: universe.length,
      rejected,
      shortlisted: shortlist.length,
      subscribeRequested: toRequest.length,
      ideasEmitted: 0,
      rejectedReasons,
      shortlist,
      momentumHotSwap,
      momentumRanked,
      broadUniverseChallengers: broadUniverseChallengerCount,
      broadUniverseHotSwapWinners: broadUniverseHotSwapWinnerCount,
      rth,
      at: new Date().toISOString(),
      honesty: continuousIntelligence.honesty,
    };
    eventBus.emit(EVENTS.OPPORTUNITY_SCAN_COMPLETED, lastScan);
    return lastScan;
  } finally {
    inFlight = false;
  }
}

export class OpportunityDiscoveryWorker {
  private timeoutId: NodeJS.Timeout | null = null;
  private stopped = true;
  /** Idempotent guard — ArgusCoreBoot and SystemBootstrap both call start(). */
  private running = false;

  start() {
    if (!isOpportunityLoopEnabled()) {
      console.log('[OpportunityDiscovery] ARGUS_OPPORTUNITY_LOOP_ENABLED is not true — idle. Watch universe unchanged.');
      return;
    }
    if (this.running) {
      console.log('[OpportunityDiscovery] Already running — ignoring duplicate start().');
      return;
    }
    this.running = true;
    this.stopped = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    marketUniverseScannerWorker.start();
    console.log(
      `[OpportunityDiscovery] Adaptive snapshot scan `
      + `(RTH ${continuousIntelligence.snapshotScanRthMs}ms / off ${continuousIntelligence.snapshotScanOffHoursMs}ms). `
      + 'Does not emit trade ideas.',
    );
    void this.tick();
  }

  stop() {
    this.stopped = true;
    this.running = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    marketUniverseScannerWorker.stop();
  }

  private async tick() {
    if (this.stopped) return;
    try {
      await runOpportunityScan();
    } catch (e) {
      console.warn('[OpportunityDiscovery] scan tick failed', e);
    }
    if (this.stopped) return;
    const delay = isSnapshotScannerRth()
      ? continuousIntelligence.snapshotScanRthMs
      : continuousIntelligence.snapshotScanOffHoursMs;
    this.timeoutId = setTimeout(() => {
      void this.tick();
    }, delay);
  }
}

export const opportunityDiscoveryWorker = new OpportunityDiscoveryWorker();
