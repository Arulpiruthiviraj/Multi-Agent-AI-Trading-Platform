/**
 * Opportunity discovery loop. Research/ranking + IEX subscribe requests only.
 * Never emits TRADE_IDEA_GENERATED. Never imports OMS / BrokerManager / RiskEngine.
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
import { upsertCandidate } from './candidateLifecycle';
import { getCachedBroadUniverseSymbols, marketUniverseScannerWorker } from './MarketUniverseScanner';

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
    // Additive only - empty unless ARGUS_BROAD_UNIVERSE_ENABLED and a refresh has already run.
    // getCachedBroadUniverseSymbols() is already ranked by real dollar volume descending; take only
    // the real top-N per scan rather than folding in the whole (up to broadUniverseMaxCandidates)
    // cached list. Every name still passes through evaluateOpportunityCandidate() below like any
    // other entry.
    ...getCachedBroadUniverseSymbols().slice(0, continuousIntelligence.broadUniverseTopNPerScan),
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

export async function runOpportunityScan(): Promise<OpportunityScanStats> {
  if (!isOpportunityLoopEnabled()) {
    lastScan = { ...EMPTY, enabled: false, at: new Date().toISOString(), ran: false };
    return lastScan;
  }
  if (inFlight) {
    lastScan = { ...lastScan, skippedOverlap: true, enabled: true };
    return lastScan;
  }
  inFlight = true;
  const rejectedReasons: Record<string, number> = {};
  const shortlist: OpportunityScanStats['shortlist'] = [];
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

    const cap = continuousIntelligence.maxActiveSubscriptions;
    const budget = Math.max(0, Math.min(
      continuousIntelligence.maxNewSubscriptionsPerCycle,
      cap - active.size,
    ));
    const ranked = [...shortlist].sort((a, b) => {
      const pa = marketDataWorker.getLatestPrice(a.symbol);
      const pb = marketDataWorker.getLatestPrice(b.symbol);
      const sa = pa && pa > 0 ? 1 : 0;
      const sb = pb && pb > 0 ? 1 : 0;
      return sb - sa;
    });
    for (const row of ranked) {
      upsertCandidate({
        symbol: row.symbol,
        state: active.has(row.symbol) ? 'WATCHING' : 'DISCOVERED',
        assetClass: row.assetClass,
        reason: row.reason,
      });
    }
    const toRequest = ranked
      .filter((row) => !active.has(row.symbol))
      .slice(0, budget);

    for (const row of toRequest) {
      eventBus.emit(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, {
        symbol: row.symbol,
        source: 'OpportunityDiscovery',
        reason: 'SEED_UNIVERSE_EXPANSION',
        honesty: 'Subscribe request only — not a trade idea and not an order.',
      });
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
  private intervalId: NodeJS.Timeout | null = null;

  start() {
    if (!isOpportunityLoopEnabled()) {
      console.log('[OpportunityDiscovery] ARGUS_OPPORTUNITY_LOOP_ENABLED is not true — idle. Watch universe unchanged.');
      return;
    }
    if (this.intervalId) return;
    marketUniverseScannerWorker.start();
    void runOpportunityScan();
    this.intervalId = setInterval(() => {
      void runOpportunityScan();
    }, continuousIntelligence.opportunityScanMs);
    console.log(`[OpportunityDiscovery] Scan every ${continuousIntelligence.opportunityScanMs}ms. Does not emit trade ideas.`);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    marketUniverseScannerWorker.stop();
  }
}

export const opportunityDiscoveryWorker = new OpportunityDiscoveryWorker();
