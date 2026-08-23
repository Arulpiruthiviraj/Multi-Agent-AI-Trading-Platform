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
  /** Dynamic symbols are eviction-immune until this dwell elapses (unless tick floor met). */
  minDynamicDwellMs: number;
  /** Alternate dwell exit: enough ticks to evaluate setups before eviction. */
  minDynamicDwellTicks: number;
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
    minDynamicDwellMs: requireNumber(raw.minDynamicDwellMs, 'minDynamicDwellMs'),
    minDynamicDwellTicks: requireNumber(raw.minDynamicDwellTicks, 'minDynamicDwellTicks'),
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
    honesty: raw.honesty,
  };
  if (cfg.coreStreamingSymbols.length > cfg.maxActiveSubscriptions) {
    throw new Error(
      'config/continuousIntelligence.json coreStreamingSymbols length must be <= maxActiveSubscriptions',
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
