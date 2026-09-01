/**
 * Opportunity discovery loop. Research/ranking + IEX subscribe requests only.
 * Never emits TRADE_IDEA_GENERATED. Never imports OMS / BrokerManager / RiskEngine.
 *
 * During RTH, SnapshotScanner REST-ranks 100+ liquid names every ~30s and hot-swaps
 * non-anchor WebSocket slots via WATCHLIST_SUBSCRIBE_REQUESTED. MarketDataWorker
 * prunes least-scored / least-ticked unprotected symbols so the stream never exceeds
 * MarketDataWorker.getEffectiveStreamingCap() (Alpaca ~12 / IBKR Gateway ~90; anchors locked).
 */
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { looksLikeListedTicker } from '../ai/AIOutputValidator';
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
import { getCachedBroadUniverseSymbols, getCachedMoverSymbols, marketUniverseScannerWorker } from './MarketUniverseScanner';
import {
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
  const names = [
    ...continuousIntelligence.seedSymbols,
    ...continuousIntelligence.watchUniverseSymbols,
    ...continuousIntelligence.momentumScanUniverseSymbols,
    ...getCachedBroadUniverseSymbols().slice(0, continuousIntelligence.broadUniverseTopNPerScan),
    // Phase 17 (2026-09-01): real Alpaca top-gainers/losers, already liquidity/ADV-screened by
    // MarketUniverseScanner.refreshMoversCache() - same evaluateOpportunityCandidate() gate below,
    // never a trade by itself.
    ...getCachedMoverSymbols().slice(0, continuousIntelligence.moversTopNPerScan),
  ];
  if (isPennyStockEnabled()) {
    names.push(...continuousIntelligence.pennyWatchSymbols);
  }
  return [...new Set(names.map((s) => s.trim().toUpperCase()).filter(Boolean))];
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
 */
export function blendedHotSwapScore(sym: string, baseScoreOf: (symbol: string) => number): number {
  const base = baseScoreOf(sym);
  const isVerifiedMover = getCachedMoverSymbols().includes(sym.toUpperCase());
  return isVerifiedMover ? base + continuousIntelligence.moverPriorityScoreBonus : base;
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

    if (continuousIntelligence.momentumRotationEnabled) {
      const top = await getTopMomentumCandidates(continuousIntelligence.snapshotTopCandidates, { now });
      momentumRanked = top.length;
      const activeDynamic = marketDataWorker.getDynamicSymbols();
      // Fill empty slots up to maxNewSubscriptionsPerCycle; when full, hot-swap at most 1.
      const maxSwaps = emptySlots > 0
        ? Math.min(continuousIntelligence.maxNewSubscriptionsPerCycle, emptySlots)
        : Math.min(continuousIntelligence.momentumHotSwapSlotsPerCycle, 1);
      const planned = planSnapshotHotSwap({
        top,
        active,
        activeDynamic,
        emptySlots,
        maxSwaps,
        scoreEdge: continuousIntelligence.snapshotMomentumScoreEdge,
        scoreOf: (sym) => blendedHotSwapScore(sym, (s) =>
          getLastSnapshotScore(s)
          ?? marketDataWorker.getDynamicMomentumScore(s)
          ?? 0),
      });
      toRequest = planned;
      momentumHotSwap = planned.length > 0 && (emptySlots === 0 || rth);

      // Phase 4D (Dynamic Subscription Priority Queue, 2026-08-26): recomputes the IDENTICAL
      // decision rule planSnapshotHotSwap already applied above, purely to explain every
      // candidate's outcome (PROMOTED/NOT_PROMOTED/ALREADY_ACTIVE + reason). Never changes
      // `toRequest`/`momentumHotSwap` above - additive telemetry only, wrapped so it can never
      // affect the real subscribe decision.
      try {
        const decisions = explainSnapshotHotSwapDecisions({
          top, active, activeDynamic,
          emptySlots,
          maxSwaps: emptySlots > 0 ? Math.min(continuousIntelligence.maxNewSubscriptionsPerCycle, emptySlots) : Math.min(continuousIntelligence.momentumHotSwapSlotsPerCycle, 1),
          scoreEdge: continuousIntelligence.snapshotMomentumScoreEdge,
          scoreOf: (sym) => blendedHotSwapScore(sym, (s) => getLastSnapshotScore(s) ?? marketDataWorker.getDynamicMomentumScore(s) ?? 0),
        });
        for (const d of decisions) {
          observeSafe(() => {
            structuredLogger.info('subscription_priority_decision', {
              category: 'DISCOVERY',
              eventType: `SUBSCRIPTION_${d.action}`,
              symbol: d.symbol,
              reasoning: d.reason,
            });
          });
        }
      } catch (e) {
        console.error('[OpportunityDiscovery] Subscription priority explainer failed (does not affect the real hot-swap decision)', e);
      }
    } else if (emptySlots > 0) {
      toRequest = shortlist
        .filter((row) => !active.has(row.symbol))
        .slice(0, Math.min(continuousIntelligence.maxNewSubscriptionsPerCycle, emptySlots))
        .map((r) => r.symbol);
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
      const score = getLastSnapshotScore(symbol) ?? undefined;
      eventBus.emit(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, {
        symbol,
        source: 'OpportunityDiscovery',
        reason: momentumHotSwap ? 'SNAPSHOT_HOT_SWAP' : 'SEED_UNIVERSE_EXPANSION',
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
