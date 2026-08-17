/**
 * Reviewed catalog of EventBus pipeline agents (config/pipelineAgents.json).
 * Membership and always-on policy live in JSON, not TypeScript literals.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface TogglableIdeaAgent {
  id: string;
  label: string;
  description: string;
  keepsBackgroundPipeline?: boolean;
  requiresEnv?: string;
}

export interface AlwaysOnAgent {
  id: string;
  label: string;
  reason: string;
  aliases?: string[];
}

export interface PipelineAgentsConfig {
  togglableIdeaAgents: TogglableIdeaAgent[];
  alwaysOn: AlwaysOnAgent[];
  cannotDisableIds: string[];
}

function loadPipelineAgents(): PipelineAgentsConfig {
  const raw = loadRepoConfigJson<PipelineAgentsConfig>('pipelineAgents.json');
  if (!Array.isArray(raw.togglableIdeaAgents) || raw.togglableIdeaAgents.length === 0) {
    throw new Error('config/pipelineAgents.json missing non-empty togglableIdeaAgents');
  }
  if (!Array.isArray(raw.alwaysOn) || raw.alwaysOn.length === 0) {
    throw new Error('config/pipelineAgents.json missing non-empty alwaysOn');
  }
  if (!Array.isArray(raw.cannotDisableIds) || raw.cannotDisableIds.length === 0) {
    throw new Error('config/pipelineAgents.json missing non-empty cannotDisableIds');
  }
  for (const a of raw.togglableIdeaAgents) {
    if (typeof a.id !== 'string' || typeof a.label !== 'string' || typeof a.description !== 'string') {
      throw new Error('config/pipelineAgents.json togglableIdeaAgents need id, label, description');
    }
  }
  for (const a of raw.alwaysOn) {
    if (typeof a.id !== 'string' || typeof a.label !== 'string' || typeof a.reason !== 'string') {
      throw new Error('config/pipelineAgents.json alwaysOn entries need id, label, reason');
    }
  }
  if (raw.cannotDisableIds.some((id) => typeof id !== 'string' || !id)) {
    throw new Error('config/pipelineAgents.json cannotDisableIds must be non-empty strings');
  }
  return raw;
}

export const pipelineAgentsConfig: PipelineAgentsConfig = loadPipelineAgents();

export function togglableIdeaAgentIds(): string[] {
  return pipelineAgentsConfig.togglableIdeaAgents.map((a) => a.id);
}

export function findTogglableIdeaAgent(id: string): TogglableIdeaAgent | undefined {
  return pipelineAgentsConfig.togglableIdeaAgents.find((a) => a.id === id);
}

export function isCannotDisableAgent(id: string): boolean {
  return pipelineAgentsConfig.cannotDisableIds.includes(id);
}

export function isTogglableAgentAvailable(agent: TogglableIdeaAgent): boolean {
  if (!agent.requiresEnv) return true;
  return process.env[agent.requiresEnv] === 'true';
}
