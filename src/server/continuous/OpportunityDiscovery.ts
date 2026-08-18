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
import { classifyAsset, type AssetSnapshot } from '../multiAsset/AssetClassifier';
import { evaluateAssetSafety } from '../multiAsset/SafetyFilter';
import { marketDataWorker } from '../services/MarketDataWorker';

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

export function evaluateOpportunityCandidate(
  raw: string,
  snapshot: Partial<AssetSnapshot> = {},
): { action: 'reject' | 'shortlist'; symbol: string | null; reason: string; assetClass?: string } {
  const symbol = looksLikeListedTicker(raw);
  if (!symbol) {
    return { action: 'reject', symbol: null, reason: 'INVALID_SYMBOL' };
  }
  const classification = classifyAsset({ symbol, ...snapshot });
  if (isPennyStockEnabled() && (classification.assetClass === 'PENNY_STOCK' || classification.assetClass === 'MICRO_CAP')) {
    const safety = evaluateAssetSafety({ symbol, ...snapshot }, classification);
    if (safety.verdict === 'BLOCK') {
      return {
        action: 'reject',
        symbol,
        reason: safety.reasons[0] || 'ASSET_CLASS_BLOCKED',
        assetClass: classification.assetClass,
      };
    }
  }
  return {
    action: 'shortlist',
    symbol,
    reason: 'seed_candidate',
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
    const seed = [...new Set(continuousIntelligence.seedSymbols)];
    let rejected = 0;
    for (const raw of seed) {
      const verdict = evaluateOpportunityCandidate(raw);
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
    const toRequest = shortlist
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
      scanned: seed.length,
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
      console.log('[OpportunityDiscovery] ARGUS_OPPORTUNITY_LOOP_ENABLED is not true — idle. Existing 4-ETF IEX universe unchanged.');
      return;
    }
    if (this.intervalId) return;
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
  }
}

export const opportunityDiscoveryWorker = new OpportunityDiscoveryWorker();
