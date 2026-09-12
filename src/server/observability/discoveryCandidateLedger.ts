/**
 * Discovery Lineage Ledger logging - shared. Originally defined inline inside
 * MarketUniverseScanner.ts (Phase A, 2026-09-02 forensic audit follow-up); extracted here
 * (Phase 28, 2026-09-02 P0 discovery fix) so MarketDataWorker.ts can log a news-triggered
 * discovery entry through the SAME mechanism without depending on MarketUniverseScanner.ts -
 * MarketUniverseScanner is a discovery-orchestration layer built on top of MarketDataWorker, not
 * the reverse, so that import direction would be a real layering inversion. No behavior change:
 * same event shape, same DISCOVERY_CANDIDATE_ADMITTED/FILTERED event types, same fields.
 *
 * Never gates a trade, never emits TRADE_IDEA_GENERATED or WATCHLIST_SUBSCRIBE_REQUESTED - purely
 * descriptive of what a real discovery/screening decision already made.
 */
import { observeSafe, structuredLogger } from './StructuredLogger';

export type ScreenRejectReason = 'PRICE' | 'DOLLAR_VOLUME' | 'SPREAD';

/** 'NEWS' added Phase 28 (2026-09-02): a candidate whose entry into the discovery/subscription
 *  path was triggered by real news-catalyst evidence (NewsCatalystStore), not the Alpaca
 *  broad-universe/movers funnels - the exact path the real FRVO incident came through. */
export type DiscoverySource = 'BROAD_UNIVERSE' | 'MARKET_MOVER' | 'NEWS';

/** 'ADV' split into two distinct reasons (2026-09-11, real gap found tracing a same-day missed-
 *  opportunity question): a symbol correctly measured as below the liquidity floor is a genuinely
 *  different situation from a symbol the ADV data source simply had no answer for - the two were
 *  previously collapsed into one 'ADV' reason, which is exactly what forced PostMarketAnalysis.ts's
 *  classify() to infer the distinction indirectly via `advShares == null` instead of reading it
 *  directly. 'ADV_BELOW_FLOOR': a real, measured advShares value exists and it is below
 *  continuousIntelligence.broadUniverseMinAvgDailyVolumeShares. 'ADV_DATA_UNAVAILABLE': no ADV
 *  value could be obtained at all (Alpaca IEX-feed batch returned no bars, and any configured FMP
 *  fallback also failed/was unavailable) - fails closed, never assumed liquid, but distinguishable
 *  from a confirmed-illiquid rejection. */
export type DiscoveryRejectReason = ScreenRejectReason | 'ADV_BELOW_FLOOR' | 'ADV_DATA_UNAVAILABLE' | 'NO_SNAPSHOT_DATA' | 'RANK_CAP';

export function logDiscoveryCandidateDecision(input: {
  symbol: string;
  source: DiscoverySource;
  admitted: boolean;
  reason: DiscoveryRejectReason | null;
  price?: number | null;
  dollarVolume?: number | null;
  spreadBps?: number | null;
  advShares?: number | null;
  /** True when this candidate's real intraday gap clears continuousIntelligence.gapMoverMinAbsPct -
   *  a genuinely additional discovery signal (gap-ups/gap-downs), computed from data already
   *  fetched for the liquidity screen, never a new API call or a bypass of that screen. */
  gapMover?: boolean;
  gapPct?: number | null;
  /** True when this candidate's real today's-volume/ADV ratio clears
   *  continuousIntelligence.rvolMoverMinRatio - observability only, computed from data already
   *  fetched for the liquidity/ADV screens, never a new API call. */
  rvolMover?: boolean;
  rvol?: number | null;
}): void {
  observeSafe(() => {
    structuredLogger.info('discovery_candidate_decision', {
      category: 'DISCOVERY',
      eventType: input.admitted ? 'DISCOVERY_CANDIDATE_ADMITTED' : 'DISCOVERY_CANDIDATE_FILTERED',
      symbol: input.symbol,
      source: input.source,
      reason: input.reason,
      price: input.price ?? null,
      dollarVolume: input.dollarVolume ?? null,
      spreadBps: input.spreadBps ?? null,
      advShares: input.advShares ?? null,
      gapMover: input.gapMover ?? false,
      gapPct: input.gapPct ?? null,
      rvolMover: input.rvolMover ?? false,
      rvol: input.rvol ?? null,
    });
  });
}
