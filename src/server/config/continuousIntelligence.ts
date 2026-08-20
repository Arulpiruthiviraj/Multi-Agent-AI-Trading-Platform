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
  protectedSymbols: string[];
  seedSymbols: string[];
  watchUniverseSymbols: string[];
  pennyWatchSymbols: string[];
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
  return {
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
    protectedSymbols: requireSymbolList(raw.protectedSymbols, 'protectedSymbols', false),
    seedSymbols: requireSymbolList(raw.seedSymbols, 'seedSymbols', false),
    watchUniverseSymbols: requireSymbolList(raw.watchUniverseSymbols, 'watchUniverseSymbols', false),
    pennyWatchSymbols: requireSymbolList(raw.pennyWatchSymbols, 'pennyWatchSymbols', true),
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
    honesty: raw.honesty,
  };
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
