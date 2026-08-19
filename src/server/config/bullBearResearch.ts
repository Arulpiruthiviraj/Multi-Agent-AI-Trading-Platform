/**
 * ==========================================================
 * Module: config/bullBearResearch
 *
 * Purpose:
 * Load config/bullBearResearch.json: researcher role text, required qualitative fields, and
 * which numeric keys must come from Quant (stripped by parseResearchNote).
 *
 * Enablement is an env var whose *name* is in JSON (enabledEnvVar, currently
 * QUANT_BULL_BEAR_ENABLED). Default is off. When that env is true, ChiefTrader injects
 * qualitative Bull/Bear notes into the debate path; RiskEngine is never bypassed.
 * ==========================================================
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';
import { isRuntimeFlagEnabled } from './effectiveRuntimeConfig';

export interface BullBearResearchConfig {
  enabledEnvVar: string;
  schemaVersion: number;
  bullAgentName: string;
  bearAgentName: string;
  bearHoldMinConfidence: number;
  bullRole: string;
  bearRole: string;
  requiredFields: string[];
  numericFieldsMustComeFromQuant: string[];
}

function loadBullBearResearch(): BullBearResearchConfig {
  const raw = loadRepoConfigJson<BullBearResearchConfig>('bullBearResearch.json');
  if (typeof raw.enabledEnvVar !== 'string' || !raw.enabledEnvVar) {
    throw new Error('config/bullBearResearch.json missing enabledEnvVar');
  }
  if (!Array.isArray(raw.requiredFields) || raw.requiredFields.length === 0) {
    throw new Error('config/bullBearResearch.json missing requiredFields');
  }
  if (typeof raw.bullAgentName !== 'string' || !raw.bullAgentName) {
    throw new Error('config/bullBearResearch.json missing bullAgentName');
  }
  if (typeof raw.bearAgentName !== 'string' || !raw.bearAgentName) {
    throw new Error('config/bullBearResearch.json missing bearAgentName');
  }
  if (typeof raw.bearHoldMinConfidence !== 'number' || !Number.isFinite(raw.bearHoldMinConfidence)) {
    throw new Error('config/bullBearResearch.json missing numeric bearHoldMinConfidence');
  }
  return raw;
}

export const bullBearResearchConfig: BullBearResearchConfig = loadBullBearResearch();

export function isBullBearResearchEnabled(): boolean {
  return isRuntimeFlagEnabled(bullBearResearchConfig.enabledEnvVar);
}
