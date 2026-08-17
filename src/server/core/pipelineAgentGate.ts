/**
 * Per-idea-agent enable flags. Independent of Autobot Start/Stop
 * (`isLiveIdeaGenerationEnabled`): Autobot remains the master for *entry* idea generation;
 * a disabled agent still emits nothing even when Autobot is on.
 *
 * In-memory only. Persistence is pipelineAgentPersist.ts (routes / TradingEngine.initialize)
 * so idea-agent modules can import this without opening SQLite.
 */
import {
  findTogglableIdeaAgent,
  isCannotDisableAgent,
  isTogglableAgentAvailable,
  pipelineAgentsConfig,
  togglableIdeaAgentIds,
} from '../config/pipelineAgents';

const enabled = new Map<string, boolean>();

export type PipelineAgentToggleResult = { ok: true; enabled: boolean } | { ok: false; error: string };

function defaultEnabled(_agentId: string): boolean {
  return true;
}

export function isPipelineAgentEnabled(agentId: string): boolean {
  if (isCannotDisableAgent(agentId)) return true;
  const spec = findTogglableIdeaAgent(agentId);
  if (!spec) return true;
  if (!enabled.has(agentId)) return defaultEnabled(agentId);
  return enabled.get(agentId) === true;
}

export function setPipelineAgentEnabled(agentId: string, value: boolean): PipelineAgentToggleResult {
  if (isCannotDisableAgent(agentId)) {
    return { ok: false, error: `${agentId} cannot be disabled from Mission Control (always-on safety path).` };
  }
  const spec = findTogglableIdeaAgent(agentId);
  if (!spec) {
    return { ok: false, error: `Unknown togglable idea agent: ${agentId}` };
  }
  enabled.set(agentId, value);
  return { ok: true, enabled: value };
}

export function applyPipelineAgentEnabledMap(map: Record<string, unknown>): void {
  for (const id of togglableIdeaAgentIds()) {
    if (!Object.prototype.hasOwnProperty.call(map, id)) continue;
    if (typeof map[id] !== 'boolean') continue;
    setPipelineAgentEnabled(id, map[id]);
  }
}

export function getPipelineAgentEnabledMap(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const id of togglableIdeaAgentIds()) {
    out[id] = isPipelineAgentEnabled(id);
  }
  return out;
}

export function setAllTogglableIdeaAgents(value: boolean): PipelineAgentToggleResult {
  for (const spec of pipelineAgentsConfig.togglableIdeaAgents) {
    if (value && !isTogglableAgentAvailable(spec)) continue;
    const result = setPipelineAgentEnabled(spec.id, value);
    if (result.ok === false && value) continue;
    if (result.ok === false) return result;
  }
  return { ok: true, enabled: value };
}
