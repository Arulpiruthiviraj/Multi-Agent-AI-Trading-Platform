import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface AgentWeightConfig {
  defaults: Record<string, number>;
  consensusDebateWeight: number;
  unlistedAgentWeight: number;
  riskExitAgent: string;
  pipelineAgents: string[];
  consensusHardVetoAgents: string[];
}

export const agentWeightConfig: AgentWeightConfig = loadRepoConfigJson('agentWeights.json');

if (!Array.isArray(agentWeightConfig.pipelineAgents) || agentWeightConfig.pipelineAgents.length === 0
  || agentWeightConfig.pipelineAgents.some((a) => typeof a !== 'string')) {
  throw new Error('config/agentWeights.json missing non-empty pipelineAgents string array');
}

if (!Array.isArray(agentWeightConfig.consensusHardVetoAgents)
  || agentWeightConfig.consensusHardVetoAgents.some((a) => typeof a !== 'string')) {
  throw new Error('config/agentWeights.json missing consensusHardVetoAgents string array');
}

// Real bug found and fixed this pass: unlike every other config loader in this codebase
// (tradingSafety.ts, quantThresholds.ts, multiAsset.ts, ...), this file never validated
// defaults/consensusDebateWeight/unlistedAgentWeight/riskExitAgent even though the interface
// above declares them required. resolveWeight() in ChiefTraderAgent.ts falls back to
// unlistedAgentWeight for any agent not in the seeded default map - a missing/mistyped value
// there silently became `undefined`, propagating NaN into the weighted consensus-approval math
// (buyWeight/sellWeight accumulation) for any such agent instead of failing boot loudly.
if (!agentWeightConfig.defaults || typeof agentWeightConfig.defaults !== 'object'
  || Object.keys(agentWeightConfig.defaults).length === 0
  || Object.values(agentWeightConfig.defaults).some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
  throw new Error('config/agentWeights.json missing non-empty defaults map of agent -> finite number');
}

if (typeof agentWeightConfig.consensusDebateWeight !== 'number' || !Number.isFinite(agentWeightConfig.consensusDebateWeight)) {
  throw new Error('config/agentWeights.json missing numeric consensusDebateWeight');
}

if (typeof agentWeightConfig.unlistedAgentWeight !== 'number' || !Number.isFinite(agentWeightConfig.unlistedAgentWeight)) {
  throw new Error('config/agentWeights.json missing numeric unlistedAgentWeight');
}

if (typeof agentWeightConfig.riskExitAgent !== 'string' || !agentWeightConfig.riskExitAgent) {
  throw new Error('config/agentWeights.json missing non-empty riskExitAgent string');
}

export const defaultAgentWeights: Record<string, number> = { ...agentWeightConfig.defaults };
