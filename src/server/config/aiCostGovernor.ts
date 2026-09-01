/**
 * Loads config/aiCostGovernor.json - Project A (AI Cost Governor). See
 * docs/audits/ARGUS_PROJECT_A_AI_COST_GOVERNOR_DESIGN_NOTE.md for the full design. A reviewed
 * config change, not a UI/API knob. `ConsensusDebate` (ChiefTrader's routeConsensus ensemble) is
 * deliberately absent from `policies` - out of scope for this entire feature, not merely deferred.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';
import { isRuntimeFlagEnabled } from './effectiveRuntimeConfig';

export type CostTier = 'LOCAL' | 'ECONOMICAL' | 'STRONG';

export interface AiCostGovernorPolicy {
  tiers: CostTier[];
  qualityFloor: number;
}

export interface AiCostGovernorConfig {
  aiCostGovernorEnabledEnvVar: string;
  aiCostGovernorLiveEnabledEnvVar: string;
  minEffectiveSampleForTrust: number;
  maxEscalationsPerAgentPerMinute: number;
  policies: Record<string, AiCostGovernorPolicy>;
  providerCostTiers: Record<string, CostTier>;
}

const VALID_TIERS: CostTier[] = ['LOCAL', 'ECONOMICAL', 'STRONG'];

function loadAiCostGovernor(): AiCostGovernorConfig {
  const raw = loadRepoConfigJson<Record<string, unknown>>('aiCostGovernor.json');

  if (typeof raw.aiCostGovernorEnabledEnvVar !== 'string' || !raw.aiCostGovernorEnabledEnvVar) {
    throw new Error('config/aiCostGovernor.json missing string field: aiCostGovernorEnabledEnvVar');
  }
  if (typeof raw.aiCostGovernorLiveEnabledEnvVar !== 'string' || !raw.aiCostGovernorLiveEnabledEnvVar) {
    throw new Error('config/aiCostGovernor.json missing string field: aiCostGovernorLiveEnabledEnvVar');
  }
  if (typeof raw.minEffectiveSampleForTrust !== 'number' || !(raw.minEffectiveSampleForTrust > 0)) {
    throw new Error('config/aiCostGovernor.json minEffectiveSampleForTrust must be a positive number');
  }
  if (typeof raw.maxEscalationsPerAgentPerMinute !== 'number' || !(raw.maxEscalationsPerAgentPerMinute > 0)) {
    throw new Error('config/aiCostGovernor.json maxEscalationsPerAgentPerMinute must be a positive number');
  }

  const rawPolicies = raw.policies as Record<string, any>;
  if (!rawPolicies || typeof rawPolicies !== 'object') {
    throw new Error('config/aiCostGovernor.json missing policies');
  }
  const policies: Record<string, AiCostGovernorPolicy> = {};
  for (const [agentType, p] of Object.entries(rawPolicies)) {
    if (!Array.isArray(p?.tiers) || p.tiers.length === 0 || !p.tiers.every((t: unknown) => VALID_TIERS.includes(t as CostTier))) {
      throw new Error(`config/aiCostGovernor.json policies.${agentType}.tiers must be a non-empty array of LOCAL|ECONOMICAL|STRONG`);
    }
    if (typeof p?.qualityFloor !== 'number' || p.qualityFloor < 0 || p.qualityFloor > 1) {
      throw new Error(`config/aiCostGovernor.json policies.${agentType}.qualityFloor must be a number in [0,1]`);
    }
    policies[agentType] = { tiers: p.tiers as CostTier[], qualityFloor: p.qualityFloor };
  }

  const rawCostTiers = raw.providerCostTiers as Record<string, unknown>;
  if (!rawCostTiers || typeof rawCostTiers !== 'object') {
    throw new Error('config/aiCostGovernor.json missing providerCostTiers');
  }
  const providerCostTiers: Record<string, CostTier> = {};
  for (const [providerName, tier] of Object.entries(rawCostTiers)) {
    if (!VALID_TIERS.includes(tier as CostTier)) {
      throw new Error(`config/aiCostGovernor.json providerCostTiers.${providerName} must be LOCAL|ECONOMICAL|STRONG`);
    }
    providerCostTiers[providerName] = tier as CostTier;
  }

  return {
    aiCostGovernorEnabledEnvVar: raw.aiCostGovernorEnabledEnvVar,
    aiCostGovernorLiveEnabledEnvVar: raw.aiCostGovernorLiveEnabledEnvVar,
    minEffectiveSampleForTrust: raw.minEffectiveSampleForTrust,
    maxEscalationsPerAgentPerMinute: raw.maxEscalationsPerAgentPerMinute,
    policies,
    providerCostTiers,
  };
}

export const aiCostGovernor: AiCostGovernorConfig = loadAiCostGovernor();

/** Off unless the operator has explicitly set this env var to 'true'. Master switch. */
export function isAiCostGovernorEnabled(): boolean {
  return isRuntimeFlagEnabled(aiCostGovernor.aiCostGovernorEnabledEnvVar);
}

/** True (the safe default) unless the operator has ALSO explicitly enabled the separate live-routing
 *  flag - even with the master flag above on, the governor stays shadow-only (computes and logs what
 *  it would have chosen, never changes real routing) until this returns false. */
export function isAiCostGovernorShadowOnly(): boolean {
  return !isRuntimeFlagEnabled(aiCostGovernor.aiCostGovernorLiveEnabledEnvVar);
}

export function policyForAgentType(agentType: string): AiCostGovernorPolicy | undefined {
  return aiCostGovernor.policies[agentType];
}

export function costTierForProviderName(providerName: string): CostTier | undefined {
  return aiCostGovernor.providerCostTiers[providerName];
}
