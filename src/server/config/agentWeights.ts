import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface AgentWeightConfig {
  defaults: Record<string, number>;
  consensusDebateWeight: number;
  unlistedAgentWeight: number;
  riskExitAgent: string;
}

export const agentWeightConfig: AgentWeightConfig = loadRepoConfigJson('agentWeights.json');

export const defaultAgentWeights: Record<string, number> = { ...agentWeightConfig.defaults };
