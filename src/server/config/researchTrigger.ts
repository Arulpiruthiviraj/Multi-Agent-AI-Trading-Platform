/**
 * Loads config/researchTrigger.json - ResearchTriggerEngine's deterministic policy for
 * automatically invoking the isolated LangGraph research service. A reviewed config change, not a
 * UI/API knob. Same off-unless-explicit convention as config/langGraphResearch.json's own master flag.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';
import { isRuntimeFlagEnabled } from './effectiveRuntimeConfig';

export interface ResearchTriggerConfig {
  researchTriggerEnabledEnvVar: string;
  requirePaperTrading: boolean;
  minimumCompletedTrades: number;
  minimumResearchIntervalMs: number;
  maxAutomaticRunsPerStrategyPerDay: number;
  maxGlobalAutomaticRunsPerDay: number;
}

function loadResearchTrigger(): ResearchTriggerConfig {
  const raw = loadRepoConfigJson<Record<string, unknown>>('researchTrigger.json');

  if (typeof raw.researchTriggerEnabledEnvVar !== 'string' || !raw.researchTriggerEnabledEnvVar) {
    throw new Error('config/researchTrigger.json missing string field: researchTriggerEnabledEnvVar');
  }
  if (typeof raw.requirePaperTrading !== 'boolean') {
    throw new Error('config/researchTrigger.json requirePaperTrading must be a boolean');
  }
  for (const key of ['minimumCompletedTrades', 'minimumResearchIntervalMs', 'maxAutomaticRunsPerStrategyPerDay', 'maxGlobalAutomaticRunsPerDay'] as const) {
    if (typeof raw[key] !== 'number' || !(raw[key] as number > 0)) {
      throw new Error(`config/researchTrigger.json ${key} must be a positive number`);
    }
  }

  return {
    researchTriggerEnabledEnvVar: raw.researchTriggerEnabledEnvVar,
    requirePaperTrading: raw.requirePaperTrading as boolean,
    minimumCompletedTrades: raw.minimumCompletedTrades as number,
    minimumResearchIntervalMs: raw.minimumResearchIntervalMs as number,
    maxAutomaticRunsPerStrategyPerDay: raw.maxAutomaticRunsPerStrategyPerDay as number,
    maxGlobalAutomaticRunsPerDay: raw.maxGlobalAutomaticRunsPerDay as number,
  };
}

export const researchTrigger: ResearchTriggerConfig = loadResearchTrigger();

/** Off unless the operator has explicitly set this env var to 'true'. */
export function isResearchTriggerEnabled(): boolean {
  return isRuntimeFlagEnabled(researchTrigger.researchTriggerEnabledEnvVar);
}
