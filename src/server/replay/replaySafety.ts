import { loadRepoConfigJson } from '../config/loadRepoConfigJson';

export interface ReplayCostProfile {
  commissionPerShare: number;
  spreadBps: number;
  slippageBps: number;
}

export interface ReplaySafetyConfig {
  replayEngineVersion: string;
  supportedFrequencies: string[];
  defaultFrequency: string;
  defaultTimezone: string;
  displayTimezones: string[];
  defaultInitialCapital: number;
  defaultAllocationBudget: number;
  capitalPresets: number[];
  costProfiles: Record<string, ReplayCostProfile>;
  defaultCostProfile: string;
  zeroCostWarning: string;
  executionModel: string;
  minSharpeTrades: number;
  minSortinoTrades: number;
  aiCallLimit: number;
  aiCostLimitUsd: number;
  aiTimeoutMs: number;
  defaultAiMode: string;
  aiModes: string[];
  /** Honest label: aiMode does not invent LLM votes or change consensus floors. */
  aiModeHonestyDescription: string;
  allowBuysInReplay: boolean;
  shortSellingDefault: boolean;
  fractionalSharesDefault: boolean;
  extendedHoursDefault: boolean;
  regularSessionStartMinutes: number;
  regularSessionEndMinutes: number;
  preMarketStartMinutes: number;
  afterHoursEndMinutes: number;
  universeSourceDefault: string;
  consensusModeDefault: string;
  consensusModeDescription: string;
  historicalFidelityLabel: string;
  historicalEvaluationDisclaimer: string;
  survivorshipBiasWarning: string;
  delistedWarning: string;
  replayTracePrefix: string;
  jsonlEventCap: number;
  historicalDiscoveryUniverse: string[];
  historicalDiscoveryFidelityWarning: string;
  historicalDiscoveryMinDollarVolume: number;
  historicalDiscoveryLookbackBars: number;
  historicalDiscoveryRescanEveryBars: number;
  historicalDiscoveryMaxActiveCandidates: number;
  missedOpportunityHorizonBars: number;
  missedOpportunityFavorableMovePct: number;
  missedOpportunityLabel: string;
  maxVolumeParticipationPct: number;
  partialFillModelDescription: string;
}

export const replaySafety = loadRepoConfigJson<ReplaySafetyConfig>('replaySafety.json');
