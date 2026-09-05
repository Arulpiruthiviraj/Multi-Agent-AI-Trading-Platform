/**
 * Load config/continuousIntelligence.json. Missing keys fail boot.
 * Flags default off. Does not enable LIVE or Quant.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';
import { isRuntimeFlagEnabled } from './effectiveRuntimeConfig';

export interface ContinuousIntelligenceConfig {
  opportunityLoopEnabledEnvVar: string;
  opportunityIdeasEnabledEnvVar: string;
  portfolioIntelEnabledEnvVar: string;
  opportunityScanMs: number;
  maxActiveSubscriptions: number;
  maxNewSubscriptionsPerCycle: number;
  exitIdeaCooldownMs: number;
  screenerEvalCooldownMs: number;
  screenerMinHistoryBars: number;
  screenerMinReturnPct: number;
  maxCandidateRecords: number;
  /** Floor set restored on Alpaca "symbol limit exceeded" — must fit under maxActiveSubscriptions. */
  coreStreamingSymbols: string[];
  protectedSymbols: string[];
  seedSymbols: string[];
  watchUniverseSymbols: string[];
  campaignOpeningSurgeSymbols: string[];
  pennyWatchSymbols: string[];
  /** When true, OpportunityDiscovery may hot-swap non-anchor slots during the ET window. */
  momentumRotationEnabled: boolean;
  momentumScanWindowStartEt: string;
  momentumScanWindowEndEt: string;
  /** Absolute |change| vs prior close (e.g. 0.02 = 2%). */
  momentumMinAbsChangePct: number;
  momentumMinRvol: number;
  /** Max new WATCHLIST_SUBSCRIBE_REQUESTED during rotation window even when stream is full. */
  momentumHotSwapSlotsPerCycle: number;
  momentumRequireNewsCatalyst: boolean;
  /** Liquid REST scan universe (snapshots only — never all streamed at once). */
  momentumScanUniverseSymbols: string[];
  /** RTH OpportunityDiscovery / SnapshotScanner poll interval (ms). */
  snapshotScanRthMs: number;
  /** Off-hours / weekend poll interval (ms). */
  snapshotScanOffHoursMs: number;
  /** How many non-anchor movers to target in the dynamic WS slots. */
  snapshotTopCandidates: number;
  /** New candidate must beat weakest dynamic slot by this score margin to hot-swap. */
  snapshotMomentumScoreEdge: number;
  /** Phase 3 (Dynamic Market Data Allocation): additive hot-swap priority bonus for a symbol that
   *  is a currently-cached, real, liquidity-screened Alpaca mover. */
  moverPriorityScoreBonus: number;
  /** Universal Opportunity Discovery follow-up (2026-09-03): additive hot-swap priority bonus,
   *  scaled by ComposableRanking's own persisted finalScore (0-1) for the symbol this cycle, when
   *  available. Before this, blendedHotSwapScore() only ever saw SnapshotScanner's own raw
   *  momentum/RVOL/range score - the richer, evidence-aware 7-component ranking (gap, liquidity,
   *  newsCatalyst, agentConfidence) computed every cycle by runRankingCycle() had ZERO influence on
   *  which symbols actually receive a scarce market-data slot; it only ever fed TradePlanBuilder and
   *  MissedOpportunityDetector (diagnostic/planning paths). This wires the same already-computed
   *  score into the real subscription decision. Zero when no composable score is available this
   *  cycle for that symbol (never fabricated as 0-as-penalty). */
  composableRankingHotSwapWeight: number;
  /** Phase C (Universal Discovery Expansion): minimum absolute intraday gap-vs-open to tag a
   *  candidate gapMover:true in the Discovery Lineage Ledger - observability only. */
  gapMoverMinAbsPct: number;
  /** Phase 27 (Universal Discovery Expansion follow-up): minimum today's-volume / ADV ratio to tag
   *  a candidate rvolMover:true in the Discovery Lineage Ledger - observability only. */
  rvolMoverMinRatio: number;
  /** Dynamic symbols are eviction-immune until this dwell elapses (unless tick floor met). */
  minDynamicDwellMs: number;
  /** Alternate dwell exit: enough ticks to evaluate setups before eviction. */
  minDynamicDwellTicks: number;
  /** Bounded, single-use protection window for MarketDataWorker.requestTemporaryDataRescue() -
   *  "one more evaluation cycle" of live data for a strategy idea that was otherwise discarded
   *  solely by STALE_MARKET_DATA. Never permanent - auto-released after this many ms. */
  temporaryDataRescueMaxDurationMs: number;
  /** Bounded exploration: at most this many symbols may hold an active rescue at once, so a burst
   *  of starved-strategy requests cannot dominate the real subscription capacity. */
  maxConcurrentTemporaryDataRescues: number;
  /** Phase 18 (2026-09-01 rescue-fairness fix): real evidence (Phase 17 audit) found the same
   *  handful of ROUTINE_RECOVERY repeat-requesters (AAPL/TSLA/AI) occupied every rescue slot for
   *  hours, denying two real exploration promotions (CRM, ONON) with RESCUE_CAPACITY_FULL. This
   *  many slots are reserved exclusively for EXPLORATION/MARKET_MOVER-class requests -
   *  ROUTINE_RECOVERY requests are capped at (maxConcurrentTemporaryDataRescues - this value), so a
   *  bounded opportunity for exploration/mover candidates always exists even under high routine
   *  demand. Must be < maxConcurrentTemporaryDataRescues. */
  rescueReservedSlotsForPriorityClasses: number;
  broadUniverseEnabledEnvVar: string;
  broadUniverseAssetsCacheTtlMs: number;
  broadUniverseSnapshotCacheTtlMs: number;
  broadUniverseMinPrice: number;
  broadUniverseMaxPrice: number;
  broadUniverseMinDollarVolume: number;
  broadUniverseMaxSpreadBps: number;
  broadUniverseAllowedExchanges: string[];
  broadUniverseMaxCandidates: number;
  broadUniverseSnapshotBatchSize: number;
  broadUniverseAdvLookbackDays: number;
  broadUniverseMinAvgDailyVolumeShares: number;
  broadUniverseTopNPerScan: number;
  /** Phase 17 (2026-09-01): real Alpaca top-gainers/losers screener as an additional discovery
   *  source, gated separately from the liquidity-only broad universe. Same real Alpaca API/creds,
   *  no scraping, no new external dependency. Results still pass through the exact same
   *  price/dollar-volume/spread/exchange/ADV screen broadUniverse* already enforces before merging
   *  into the scan universe - a raw mover (e.g. a penny warrant) is never fed to the pipeline
   *  unfiltered. */
  moversEnabledEnvVar: string;
  moversCacheTtlMs: number;
  moversFetchTopNPerSide: number;
  moversTopNPerScan: number;
  /** Phase 4F: minimum gap before the same symbol can be classified as a missed opportunity again. */
  missedOpportunityDetectionCooldownMs: number;
  /** Phase 4F: retrospective evaluation window used for MFE/MAE (minutes). */
  missedOpportunityEvaluationHorizonMinutes: number;
  /** Phase 4F: how far back event_traces/risk_assessments/trades are queried to build funnel signals. */
  missedOpportunityLookbackMs: number;
  /** Phase 4H: minimum sample size before a challenger version is eligible for promotion (mirrors Kelly's existing 20-trade floor). */
  championChallengerMinSampleSize: number;
  /** Phase 4H: challenger must beat the champion's metric by at least this margin to pass the promotion gate. */
  championChallengerMinImprovementMargin: number;
  /** Phase 7E: a calibration bucket's newest real observation older than this is flagged stale (observability only, not auto-enforced). */
  calibrationMaxObservationAgeMs: number;
  /** Session-Aware Trading Architecture Phase 2 follow-up (2026-09-05): ComposableRanking's
   *  promote/reject bar, selected by real MarketSession instead of one hardcoded pair. Values are
   *  identical across sessions by default - see the JSON file's own comment for why. */
  rankingThresholdsBySession: Record<'PRE_MARKET' | 'REGULAR' | 'AFTER_HOURS', { promote: number; reject: number }>;
  /** Session-Aware Trading Architecture Phase 3 follow-up (2026-09-05): how many top-momentum
   *  candidates may receive a real javaQuantScore (Java quant engine bar-fetch + HTTP call) during
   *  the once-per-day PRE_MARKET plan-building cycle. Never applied to the ~30s RTH ranking loop. */
  javaQuantScoreCandidateLimit: number;
  honesty: string;
}

function requireNumber(raw: unknown, label: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(`config/continuousIntelligence.json ${label} must be a positive finite number`);
  }
  return raw;
}

function requireSymbolList(raw: unknown, label: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== 'string' || !s)) {
    throw new Error(`config/continuousIntelligence.json ${label} must be a string[]`);
  }
  if (!allowEmpty && raw.length === 0) {
    throw new Error(`config/continuousIntelligence.json ${label} must be a non-empty string[]`);
  }
  return (raw as string[]).map((s) => s.trim().toUpperCase());
}

function requireHhmm(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || !/^\d{2}:\d{2}$/.test(raw)) {
    throw new Error(`config/continuousIntelligence.json ${label} must be HH:MM`);
  }
  return raw;
}

function requireNonNegativeNumber(raw: unknown, label: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    throw new Error(`config/continuousIntelligence.json ${label} must be a finite number >= 0`);
  }
  return raw;
}

const RANKING_THRESHOLD_SESSIONS = ['PRE_MARKET', 'REGULAR', 'AFTER_HOURS'] as const;

function requireRankingThresholdsBySession(raw: unknown, label: string): ContinuousIntelligenceConfig['rankingThresholdsBySession'] {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`config/continuousIntelligence.json ${label} must be an object keyed by MarketSession`);
  }
  const obj = raw as Record<string, unknown>;
  const result = {} as ContinuousIntelligenceConfig['rankingThresholdsBySession'];
  for (const session of RANKING_THRESHOLD_SESSIONS) {
    const entry = obj[session];
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`config/continuousIntelligence.json ${label}.${session} must be an object with promote/reject`);
    }
    const { promote, reject } = entry as Record<string, unknown>;
    if (typeof promote !== 'number' || !Number.isFinite(promote) || promote < 0 || promote > 1) {
      throw new Error(`config/continuousIntelligence.json ${label}.${session}.promote must be a finite number in [0,1]`);
    }
    if (typeof reject !== 'number' || !Number.isFinite(reject) || reject < 0 || reject > 1) {
      throw new Error(`config/continuousIntelligence.json ${label}.${session}.reject must be a finite number in [0,1]`);
    }
    if (reject >= promote) {
      throw new Error(`config/continuousIntelligence.json ${label}.${session}.reject must be < .promote`);
    }
    result[session] = { promote, reject };
  }
  return result;
}

function loadContinuousIntelligence(): ContinuousIntelligenceConfig {
  const raw = loadRepoConfigJson<Record<string, unknown>>('continuousIntelligence.json');
  if (typeof raw.opportunityLoopEnabledEnvVar !== 'string' || !raw.opportunityLoopEnabledEnvVar) {
    throw new Error('config/continuousIntelligence.json missing opportunityLoopEnabledEnvVar');
  }
  if (typeof raw.opportunityIdeasEnabledEnvVar !== 'string' || !raw.opportunityIdeasEnabledEnvVar) {
    throw new Error('config/continuousIntelligence.json missing opportunityIdeasEnabledEnvVar');
  }
  if (typeof raw.portfolioIntelEnabledEnvVar !== 'string' || !raw.portfolioIntelEnabledEnvVar) {
    throw new Error('config/continuousIntelligence.json missing portfolioIntelEnabledEnvVar');
  }
  if (typeof raw.honesty !== 'string' || !raw.honesty) {
    throw new Error('config/continuousIntelligence.json missing honesty');
  }
  if (typeof raw.broadUniverseEnabledEnvVar !== 'string' || !raw.broadUniverseEnabledEnvVar) {
    throw new Error('config/continuousIntelligence.json missing broadUniverseEnabledEnvVar');
  }
  if (typeof raw.moversEnabledEnvVar !== 'string' || !raw.moversEnabledEnvVar) {
    throw new Error('config/continuousIntelligence.json missing moversEnabledEnvVar');
  }
  const cfg: ContinuousIntelligenceConfig = {
    opportunityLoopEnabledEnvVar: raw.opportunityLoopEnabledEnvVar,
    opportunityIdeasEnabledEnvVar: raw.opportunityIdeasEnabledEnvVar,
    portfolioIntelEnabledEnvVar: raw.portfolioIntelEnabledEnvVar,
    opportunityScanMs: requireNumber(raw.opportunityScanMs, 'opportunityScanMs'),
    maxActiveSubscriptions: requireNumber(raw.maxActiveSubscriptions, 'maxActiveSubscriptions'),
    maxNewSubscriptionsPerCycle: requireNumber(raw.maxNewSubscriptionsPerCycle, 'maxNewSubscriptionsPerCycle'),
    exitIdeaCooldownMs: requireNumber(raw.exitIdeaCooldownMs, 'exitIdeaCooldownMs'),
    screenerEvalCooldownMs: requireNumber(raw.screenerEvalCooldownMs, 'screenerEvalCooldownMs'),
    screenerMinHistoryBars: requireNumber(raw.screenerMinHistoryBars, 'screenerMinHistoryBars'),
    screenerMinReturnPct: requireNumber(raw.screenerMinReturnPct, 'screenerMinReturnPct'),
    maxCandidateRecords: requireNumber(raw.maxCandidateRecords, 'maxCandidateRecords'),
    coreStreamingSymbols: requireSymbolList(raw.coreStreamingSymbols, 'coreStreamingSymbols', false),
    protectedSymbols: requireSymbolList(raw.protectedSymbols, 'protectedSymbols', false),
    seedSymbols: requireSymbolList(raw.seedSymbols, 'seedSymbols', false),
    watchUniverseSymbols: requireSymbolList(raw.watchUniverseSymbols, 'watchUniverseSymbols', false),
    campaignOpeningSurgeSymbols: requireSymbolList(raw.campaignOpeningSurgeSymbols, 'campaignOpeningSurgeSymbols', false),
    pennyWatchSymbols: requireSymbolList(raw.pennyWatchSymbols, 'pennyWatchSymbols', true),
    momentumRotationEnabled: raw.momentumRotationEnabled === true,
    momentumScanWindowStartEt: requireHhmm(raw.momentumScanWindowStartEt, 'momentumScanWindowStartEt'),
    momentumScanWindowEndEt: requireHhmm(raw.momentumScanWindowEndEt, 'momentumScanWindowEndEt'),
    momentumMinAbsChangePct: requireNonNegativeNumber(raw.momentumMinAbsChangePct, 'momentumMinAbsChangePct'),
    momentumMinRvol: requireNumber(raw.momentumMinRvol, 'momentumMinRvol'),
    momentumHotSwapSlotsPerCycle: requireNumber(raw.momentumHotSwapSlotsPerCycle, 'momentumHotSwapSlotsPerCycle'),
    momentumRequireNewsCatalyst: raw.momentumRequireNewsCatalyst === true,
    momentumScanUniverseSymbols: requireSymbolList(raw.momentumScanUniverseSymbols, 'momentumScanUniverseSymbols', true),
    snapshotScanRthMs: requireNumber(raw.snapshotScanRthMs, 'snapshotScanRthMs'),
    snapshotScanOffHoursMs: requireNumber(raw.snapshotScanOffHoursMs, 'snapshotScanOffHoursMs'),
    snapshotTopCandidates: requireNumber(raw.snapshotTopCandidates, 'snapshotTopCandidates'),
    snapshotMomentumScoreEdge: requireNonNegativeNumber(raw.snapshotMomentumScoreEdge, 'snapshotMomentumScoreEdge'),
    moverPriorityScoreBonus: requireNonNegativeNumber(raw.moverPriorityScoreBonus, 'moverPriorityScoreBonus'),
    composableRankingHotSwapWeight: requireNonNegativeNumber(raw.composableRankingHotSwapWeight, 'composableRankingHotSwapWeight'),
    gapMoverMinAbsPct: requireNonNegativeNumber(raw.gapMoverMinAbsPct, 'gapMoverMinAbsPct'),
    rvolMoverMinRatio: requireNonNegativeNumber(raw.rvolMoverMinRatio, 'rvolMoverMinRatio'),
    minDynamicDwellMs: requireNumber(raw.minDynamicDwellMs, 'minDynamicDwellMs'),
    minDynamicDwellTicks: requireNumber(raw.minDynamicDwellTicks, 'minDynamicDwellTicks'),
    temporaryDataRescueMaxDurationMs: requireNumber(raw.temporaryDataRescueMaxDurationMs, 'temporaryDataRescueMaxDurationMs'),
    maxConcurrentTemporaryDataRescues: requireNumber(raw.maxConcurrentTemporaryDataRescues, 'maxConcurrentTemporaryDataRescues'),
    rescueReservedSlotsForPriorityClasses: requireNumber(raw.rescueReservedSlotsForPriorityClasses, 'rescueReservedSlotsForPriorityClasses'),
    broadUniverseEnabledEnvVar: raw.broadUniverseEnabledEnvVar,
    broadUniverseAssetsCacheTtlMs: requireNumber(raw.broadUniverseAssetsCacheTtlMs, 'broadUniverseAssetsCacheTtlMs'),
    broadUniverseSnapshotCacheTtlMs: requireNumber(raw.broadUniverseSnapshotCacheTtlMs, 'broadUniverseSnapshotCacheTtlMs'),
    broadUniverseMinPrice: requireNumber(raw.broadUniverseMinPrice, 'broadUniverseMinPrice'),
    broadUniverseMaxPrice: requireNumber(raw.broadUniverseMaxPrice, 'broadUniverseMaxPrice'),
    broadUniverseMinDollarVolume: requireNumber(raw.broadUniverseMinDollarVolume, 'broadUniverseMinDollarVolume'),
    broadUniverseMaxSpreadBps: requireNumber(raw.broadUniverseMaxSpreadBps, 'broadUniverseMaxSpreadBps'),
    broadUniverseAllowedExchanges: requireSymbolList(raw.broadUniverseAllowedExchanges, 'broadUniverseAllowedExchanges', false),
    broadUniverseMaxCandidates: requireNumber(raw.broadUniverseMaxCandidates, 'broadUniverseMaxCandidates'),
    broadUniverseSnapshotBatchSize: requireNumber(raw.broadUniverseSnapshotBatchSize, 'broadUniverseSnapshotBatchSize'),
    broadUniverseAdvLookbackDays: requireNumber(raw.broadUniverseAdvLookbackDays, 'broadUniverseAdvLookbackDays'),
    broadUniverseMinAvgDailyVolumeShares: requireNumber(raw.broadUniverseMinAvgDailyVolumeShares, 'broadUniverseMinAvgDailyVolumeShares'),
    broadUniverseTopNPerScan: requireNumber(raw.broadUniverseTopNPerScan, 'broadUniverseTopNPerScan'),
    moversEnabledEnvVar: raw.moversEnabledEnvVar,
    moversCacheTtlMs: requireNumber(raw.moversCacheTtlMs, 'moversCacheTtlMs'),
    moversFetchTopNPerSide: requireNumber(raw.moversFetchTopNPerSide, 'moversFetchTopNPerSide'),
    moversTopNPerScan: requireNumber(raw.moversTopNPerScan, 'moversTopNPerScan'),
    missedOpportunityDetectionCooldownMs: requireNumber(raw.missedOpportunityDetectionCooldownMs, 'missedOpportunityDetectionCooldownMs'),
    missedOpportunityEvaluationHorizonMinutes: requireNumber(raw.missedOpportunityEvaluationHorizonMinutes, 'missedOpportunityEvaluationHorizonMinutes'),
    missedOpportunityLookbackMs: requireNumber(raw.missedOpportunityLookbackMs, 'missedOpportunityLookbackMs'),
    championChallengerMinSampleSize: requireNumber(raw.championChallengerMinSampleSize, 'championChallengerMinSampleSize'),
    championChallengerMinImprovementMargin: requireNonNegativeNumber(raw.championChallengerMinImprovementMargin, 'championChallengerMinImprovementMargin'),
    calibrationMaxObservationAgeMs: requireNumber(raw.calibrationMaxObservationAgeMs, 'calibrationMaxObservationAgeMs'),
    rankingThresholdsBySession: requireRankingThresholdsBySession(raw.rankingThresholdsBySession, 'rankingThresholdsBySession'),
    javaQuantScoreCandidateLimit: requireNumber(raw.javaQuantScoreCandidateLimit, 'javaQuantScoreCandidateLimit'),
    honesty: raw.honesty,
  };
  if (cfg.coreStreamingSymbols.length > cfg.maxActiveSubscriptions) {
    throw new Error(
      'config/continuousIntelligence.json coreStreamingSymbols length must be <= maxActiveSubscriptions',
    );
  }
  if (cfg.rescueReservedSlotsForPriorityClasses >= cfg.maxConcurrentTemporaryDataRescues) {
    throw new Error(
      'config/continuousIntelligence.json rescueReservedSlotsForPriorityClasses must be < maxConcurrentTemporaryDataRescues (routine recovery must retain at least one usable slot)',
    );
  }
  return cfg;
}

export const continuousIntelligence: ContinuousIntelligenceConfig = loadContinuousIntelligence();

export function isOpportunityLoopEnabled(): boolean {
  return isRuntimeFlagEnabled(continuousIntelligence.opportunityLoopEnabledEnvVar);
}

export function isOpportunityIdeasEnabled(): boolean {
  return isRuntimeFlagEnabled(continuousIntelligence.opportunityIdeasEnabledEnvVar);
}

export function isPortfolioIntelEnabled(): boolean {
  return isRuntimeFlagEnabled(continuousIntelligence.portfolioIntelEnabledEnvVar);
}

export function isBroadUniverseEnabled(): boolean {
  return isRuntimeFlagEnabled(continuousIntelligence.broadUniverseEnabledEnvVar);
}

export function isMoversEnabled(): boolean {
  return isRuntimeFlagEnabled(continuousIntelligence.moversEnabledEnvVar);
}
