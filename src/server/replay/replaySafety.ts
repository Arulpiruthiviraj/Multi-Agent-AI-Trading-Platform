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
  allowBuysInReplay: boolean;
  shortSellingDefault: boolean;
  fractionalSharesDefault: boolean;
  extendedHoursDefault: boolean;
  regularSessionStartMinutes: number;
  regularSessionEndMinutes: number;
  preMarketStartMinutes: number;
  afterHoursEndMinutes: number;
  universeSourceDefault: string;
  survivorshipBiasWarning: string;
  delistedWarning: string;
  replayTracePrefix: string;
  jsonlEventCap: number;
}

export const replaySafety = loadRepoConfigJson<ReplaySafetyConfig>('replaySafety.json');
