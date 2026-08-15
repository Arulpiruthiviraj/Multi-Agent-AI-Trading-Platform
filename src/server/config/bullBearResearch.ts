/**
 * ==========================================================
 * Module: config/bullBearResearch
 *
 * Purpose:
 * Load config/bullBearResearch.json: researcher role text, required qualitative fields, and
 * which numeric keys must come from Quant (stripped by parseResearchNote).
 *
 * Enablement is an env var whose *name* is in JSON (enabledEnvVar, currently
 * QUANT_BULL_BEAR_ENABLED). Default is off. ChiefTrader does not read this until a later
 * additive wiring pass.
 * ==========================================================
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface BullBearResearchConfig {
  enabledEnvVar: string;
  schemaVersion: number;
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
  return raw;
}

export const bullBearResearchConfig: BullBearResearchConfig = loadBullBearResearch();

export function isBullBearResearchEnabled(): boolean {
  const envName = bullBearResearchConfig.enabledEnvVar;
  return process.env[envName] === 'true';
}
