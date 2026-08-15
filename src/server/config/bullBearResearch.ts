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
