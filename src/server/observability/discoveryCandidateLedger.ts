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

export type ScreenRejectReason = 'PRICE' | 'DOLLAR_VOLUME' | 'SPREAD' | 'SPREAD_CROSSED';

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

/**
 * 2026-09-29 (volume-provenance fix, first pass). Real, verified structural mismatch
 * (MarketUniverseScanner.ts's own 2026-09-16 comment already documents the denominator half of
 * this): computeRvol()'s numerator (today's session volume) came from Alpaca's real-time
 * `feed=iex` snapshot - IEX-reported volume only, measured live at ~1.5%-10% of true consolidated
 * volume for the same partial trading day (16-symbol same-day comparison, 2026-09-16). Its
 * denominator (avgDailyVolumeShares) comes from `feed=sip` historical daily bars (or an FMP
 * fallback) - full consolidated volume, averaged over complete trading days.
 *
 * 2026-09-29 (second review, item 5 - superseding update): the first pass only added this
 * provenance label alongside the still-computed incompatible ratio - a real gap the second review
 * correctly flagged ("makes the limitation visible; it does not make the measurements
 * compatible"). MarketUniverseScanner.ts's computeRvol() now abstains unconditionally (returns
 * null) rather than compute the incompatible ratio at all, so in practice `rvol`/`rvolProvenance`
 * are now always null and `rvolMover` is now always false - this interface/constant remain in
 * place as the documented shape for if/when a genuinely compatible same-scope volume source is
 * added (a real, separately-scoped follow-up requiring either a consolidated real-time feed this
 * account is not shown to be entitled to, or a new time-of-day-adjusted intraday ADV fetch this
 * pass is not authorized to add), not because this ratio is computed and labeled today.
 */
export interface VolumeProvenance {
  numeratorFeed: 'ALPACA_IEX_SNAPSHOT';
  numeratorScope: 'REAL_TIME_PARTIAL_SESSION_TO_OBSERVATION_TIME';
  denominatorFeed: 'ALPACA_SIP_HISTORICAL_OR_FMP_FALLBACK';
  denominatorScope: 'FULL_TRADING_DAY_AVERAGE';
  comparable: false;
  reason: string;
}

export const RVOL_PROVENANCE: VolumeProvenance = {
  numeratorFeed: 'ALPACA_IEX_SNAPSHOT',
  numeratorScope: 'REAL_TIME_PARTIAL_SESSION_TO_OBSERVATION_TIME',
  denominatorFeed: 'ALPACA_SIP_HISTORICAL_OR_FMP_FALLBACK',
  denominatorScope: 'FULL_TRADING_DAY_AVERAGE',
  comparable: false,
  reason: 'Numerator is IEX-only real-time session-to-date volume (~1.5%-10% of true consolidated volume, measured 2026-09-16); denominator is a full-day consolidated historical average. This ratio structurally understates true relative volume and is not a time-of-day-adjusted measurement - treat as a weak, directionally-biased-low signal, never a calibrated relative-volume estimate.',
};

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
  gapEvidence?: import('../continuous/discoveryGapEvidence').DiscoveryGapEvidence & { reason: string };
  /** True when this candidate's real today's-volume/ADV ratio clears
   *  continuousIntelligence.rvolMoverMinRatio - observability only, computed from data already
   *  fetched for the liquidity/ADV screens, never a new API call. */
  rvolMover?: boolean;
  rvol?: number | null;
  /** 2026-09-29 (volume-provenance fix, docs/audits/archive/ARGUS_MIDDAY_ZERO_TRADE_2026-09-29.md):
   *  rvol's own numerator/denominator come from structurally different, non-comparable sources -
   *  documented explicitly rather than left implicit. Present only when `rvol` is non-null (the
   *  computation actually ran). See RVOL_PROVENANCE below for the one real, current description. */
  rvolProvenance?: VolumeProvenance | null;
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
      gapEvidence: input.gapEvidence ?? null,
      rvolMover: input.rvolMover ?? false,
      rvol: input.rvol ?? null,
      rvolProvenance: input.rvol != null ? (input.rvolProvenance ?? RVOL_PROVENANCE) : null,
    });
  });
}
