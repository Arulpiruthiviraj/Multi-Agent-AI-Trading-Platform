import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface AgentWeightConfig {
  defaults: Record<string, number>;
  consensusDebateWeight: number;
  unlistedAgentWeight: number;
  riskExitAgent: string;
  pipelineAgents: string[];
}

export const agentWeightConfig: AgentWeightConfig = loadRepoConfigJson('agentWeights.json');

if (!Array.isArray(agentWeightConfig.pipelineAgents) || agentWeightConfig.pipelineAgents.length === 0
  || agentWeightConfig.pipelineAgents.some((a) => typeof a !== 'string')) {
  throw new Error('config/agentWeights.json missing non-empty pipelineAgents string array');
}

export const defaultAgentWeights: Record<string, number> = { ...agentWeightConfig.defaults };
