/**
 * Load config/continuousIntelligence.json. Missing keys fail boot.
 * Flags default off. Does not enable LIVE or Quant.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface ContinuousIntelligenceConfig {
  opportunityLoopEnabledEnvVar: string;
  portfolioIntelEnabledEnvVar: string;
  opportunityScanMs: number;
  maxActiveSubscriptions: number;
  maxNewSubscriptionsPerCycle: number;
  exitIdeaCooldownMs: number;
  protectedSymbols: string[];
  seedSymbols: string[];
  honesty: string;
}

function requireNumber(raw: unknown, label: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(`config/continuousIntelligence.json ${label} must be a positive finite number`);
  }
  return raw;
}

function requireSymbols(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((s) => typeof s !== 'string' || !s)) {
    throw new Error(`config/continuousIntelligence.json ${label} must be a non-empty string[]`);
  }
  return (raw as string[]).map((s) => s.trim().toUpperCase());
}

function loadContinuousIntelligence(): ContinuousIntelligenceConfig {
  const raw = loadRepoConfigJson<Record<string, unknown>>('continuousIntelligence.json');
  if (typeof raw.opportunityLoopEnabledEnvVar !== 'string' || !raw.opportunityLoopEnabledEnvVar) {
    throw new Error('config/continuousIntelligence.json missing opportunityLoopEnabledEnvVar');
  }
  if (typeof raw.portfolioIntelEnabledEnvVar !== 'string' || !raw.portfolioIntelEnabledEnvVar) {
    throw new Error('config/continuousIntelligence.json missing portfolioIntelEnabledEnvVar');
  }
  if (typeof raw.honesty !== 'string' || !raw.honesty) {
    throw new Error('config/continuousIntelligence.json missing honesty');
  }
  return {
    opportunityLoopEnabledEnvVar: raw.opportunityLoopEnabledEnvVar,
    portfolioIntelEnabledEnvVar: raw.portfolioIntelEnabledEnvVar,
    opportunityScanMs: requireNumber(raw.opportunityScanMs, 'opportunityScanMs'),
    maxActiveSubscriptions: requireNumber(raw.maxActiveSubscriptions, 'maxActiveSubscriptions'),
    maxNewSubscriptionsPerCycle: requireNumber(raw.maxNewSubscriptionsPerCycle, 'maxNewSubscriptionsPerCycle'),
    exitIdeaCooldownMs: requireNumber(raw.exitIdeaCooldownMs, 'exitIdeaCooldownMs'),
    protectedSymbols: requireSymbols(raw.protectedSymbols, 'protectedSymbols'),
    seedSymbols: requireSymbols(raw.seedSymbols, 'seedSymbols'),
    honesty: raw.honesty,
  };
}

export const continuousIntelligence: ContinuousIntelligenceConfig = loadContinuousIntelligence();

export function isOpportunityLoopEnabled(): boolean {
  return process.env[continuousIntelligence.opportunityLoopEnabledEnvVar] === 'true';
}

export function isPortfolioIntelEnabled(): boolean {
  return process.env[continuousIntelligence.portfolioIntelEnabledEnvVar] === 'true';
}
