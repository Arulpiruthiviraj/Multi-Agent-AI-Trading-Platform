/**
 * Start/stop EventBus listeners and timers for togglable idea agents.
 * Does not touch RiskEngine, OMS, ChiefTrader, PortfolioMonitor, market data, or the kill switch.
 *
 * NewsAgent keeps NewsEngine clustering running (news_veto); only TRADE_IDEA_GENERATED is gated.
 */
import { findTogglableIdeaAgent, togglableIdeaAgentIds } from '../config/pipelineAgents';
import { isPipelineAgentEnabled } from './pipelineAgentGate';
import { technicalAgent } from '../services/TechnicalAgent';
import { fundamentalAgent } from '../services/FundamentalAgent';
import { macroAgent } from '../services/MacroAgent';
import { kronosForecastAgent } from '../services/KronosForecastAgent';
import { quantSignalAgent } from '../services/QuantSignalAgent';

type AgentRuntime = { start: () => void; stop: () => void };

const runtimes: Record<string, AgentRuntime> = {
  TechnicalAgent: { start: () => technicalAgent.start(), stop: () => technicalAgent.stop() },
  NewsAgent: { start: () => { /* clustering stays on with Autobot; ideas gated in NewsEngine */ }, stop: () => { /* same */ } },
  FundamentalAgent: { start: () => fundamentalAgent.start(), stop: () => fundamentalAgent.stop() },
  MacroAgent: { start: () => macroAgent.start(), stop: () => macroAgent.stop() },
  KronosEngine: { start: () => kronosForecastAgent.start(), stop: () => kronosForecastAgent.stop() },
  QuantEngine: { start: () => quantSignalAgent.start(), stop: () => quantSignalAgent.stop() },
};

let ideaWorkersArmed = false;

function assertRuntimesCoverCatalog(): void {
  for (const id of togglableIdeaAgentIds()) {
    if (!runtimes[id]) {
      throw new Error(`pipelineAgentRuntime missing start/stop for catalog agent ${id}`);
    }
  }
}
assertRuntimesCoverCatalog();

export function areIdeaWorkersArmed(): boolean {
  return ideaWorkersArmed;
}

export function setIdeaWorkersArmed(armed: boolean): void {
  ideaWorkersArmed = armed;
}

export function applyPipelineAgentRuntime(agentId: string, enabled: boolean): void {
  const spec = findTogglableIdeaAgent(agentId);
  if (!spec || spec.keepsBackgroundPipeline) return;
  if (!ideaWorkersArmed) return;
  const rt = runtimes[agentId];
  if (!rt) return;
  if (enabled) rt.start();
  else rt.stop();
}

export function applyAllIdeaAgentRuntimes(): void {
  if (!ideaWorkersArmed) return;
  for (const id of togglableIdeaAgentIds()) {
    applyPipelineAgentRuntime(id, isPipelineAgentEnabled(id));
  }
}

export function startEnabledIdeaAgents(): void {
  ideaWorkersArmed = true;
  applyAllIdeaAgentRuntimes();
}

export function stopAllIdeaAgents(): void {
  for (const id of togglableIdeaAgentIds()) {
    const spec = findTogglableIdeaAgent(id);
    if (spec?.keepsBackgroundPipeline) continue;
    runtimes[id]?.stop();
  }
  ideaWorkersArmed = false;
}
