/**
 * Loads config/quantDecisionPolicy.json. Source of truth for the Quant-First Decision
 * Architecture's policy parameters (quant producer allowlist, support-dimension floor,
 * master switch). Policy parameters only - safety thresholds stay in tradingSafety.json.
 *
 * Not exposed as a writable API. Values stay file-reviewed, never UI-tunable.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface QuantDecisionPolicy {
  quantProducerAgents: string[];
  minQuantSupportDimensions: number;
  quantPolicySignalMaxAgeMs: number;
  quantPolicyEnabled: boolean;
}

export const quantDecisionPolicy: QuantDecisionPolicy = loadRepoConfigJson<QuantDecisionPolicy>('quantDecisionPolicy.json');

export function isQuantPolicyEnabled(): boolean {
  return quantDecisionPolicy.quantPolicyEnabled !== false;
}

export function isQuantProducerAgent(agentName: string): boolean {
  return quantDecisionPolicy.quantProducerAgents.includes(String(agentName || ''));
}

export function minQuantSupportDimensions(): number {
  const n = quantDecisionPolicy.minQuantSupportDimensions;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2;
}
