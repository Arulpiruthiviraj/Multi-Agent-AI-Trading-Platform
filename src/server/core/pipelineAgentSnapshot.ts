/**
 * Mission Control snapshot for idea-agent switches. Read-only; does not start Autobot.
 */
import {
  isTogglableAgentAvailable,
  pipelineAgentsConfig,
} from '../config/pipelineAgents';
import { getPipelineAgentEnabledMap, isPipelineAgentEnabled } from './pipelineAgentGate';
import { isLiveIdeaGenerationEnabled } from './ideaGenerationGate';
import { tradingEngine } from '../engines/TradingEngine';
import { system } from './SystemBootstrap';
import { tradingSafety } from '../config/tradingSafety';
import { getPipelineAgentHeartbeat, isPipelineAgentAlive } from './pipelineAgentHealth';
import { areIdeaWorkersArmed } from './pipelineAgentRuntime';
import { getLastOpportunityScan } from '../continuous/OpportunityDiscovery';
import { isOpportunityLoopEnabled } from '../config/continuousIntelligence';
import { fundamentalAgent } from '../services/FundamentalAgent';
import { macroAgent } from '../services/MacroAgent';
import { chiefTrader } from '../services/ChiefTraderAgent';
import { formatWhyNoTrade } from './consensusExplanation';

export function getPipelineAgentSnapshot() {
  const workersRunning = system.getStatus().running;
  const ideaWorkersArmed = areIdeaWorkersArmed();
  const deadAfterMs = tradingSafety.pipelineAgentDeadAfterMs;

  return {
    togglable: pipelineAgentsConfig.togglableIdeaAgents.map((spec) => {
      const available = isTogglableAgentAvailable(spec);
      const enabled = isPipelineAgentEnabled(spec.id);
      const heartbeat = getPipelineAgentHeartbeat(spec.id);
      const lastTickAt = spec.id === 'FundamentalAgent'
        ? (fundamentalAgent.lastTickAt ?? heartbeat.lastTickAt)
        : spec.id === 'MacroAgent'
          ? (macroAgent.lastTickAt ?? heartbeat.lastTickAt)
          : heartbeat.lastTickAt;
      const lastTickAgeMs = lastTickAt !== null ? Date.now() - lastTickAt : null;
      const alive = isPipelineAgentAlive(spec.id) || (lastTickAgeMs !== null && lastTickAgeMs <= deadAfterMs);
      let healthLabel: 'ENV_OFF' | 'OFFLINE' | 'NOT_ARMED' | 'DEAD' | 'HEALTHY' | 'GATED' = 'OFFLINE';
      if (!available) healthLabel = 'ENV_OFF';
      else if (!enabled) healthLabel = 'OFFLINE';
      else if (!ideaWorkersArmed && spec.keepsBackgroundPipeline !== true) healthLabel = 'NOT_ARMED';
      else if (!alive) healthLabel = 'DEAD';
      else if (heartbeat.currentState === 'GATED') healthLabel = 'GATED';
      else healthLabel = 'HEALTHY';
      // Real bug found and fixed this pass: `healthy` used to be computed independently of
      // healthLabel (enabled && available && alive, ignoring ideaWorkersArmed entirely), so right
      // after stopAllIdeaAgents() a stopped agent reported healthy:true and healthLabel:'NOT_ARMED'
      // on the same response object - an internally inconsistent API contract. Deriving healthy
      // from healthLabel makes them structurally unable to disagree.
      const healthy = healthLabel === 'HEALTHY';
      return {
        id: spec.id,
        label: spec.label,
        description: spec.description,
        enabled,
        available,
        unavailableReason: available ? null : `Requires ${spec.requiresEnv}=true in .env (restart after setting).`,
        keepsBackgroundPipeline: spec.keepsBackgroundPipeline === true,
        lastTickAt,
        lastTickAgeMs,
        lastSuccessfulTickAt: heartbeat.lastSuccessfulTickAt,
        lastFailureAt: heartbeat.lastFailureAt,
        consecutiveFailures: heartbeat.consecutiveFailures,
        lastError: heartbeat.lastError,
        currentState: heartbeat.currentState,
        alive,
        healthy,
        healthLabel,
      };
    }),
    alwaysOn: pipelineAgentsConfig.alwaysOn.map((spec) => ({
      id: spec.id,
      label: spec.label,
      reason: spec.reason,
      enabled: true,
    })),
    enabledMap: getPipelineAgentEnabledMap(),
    autobotEnabled: tradingEngine.state.enabled === true,
    liveIdeaGenerationEnabled: isLiveIdeaGenerationEnabled(),
    tradingState: tradingEngine.state.tradingState,
    emergencyStopActive: tradingEngine.state.emergencyStopActive === true,
    workersRunning,
    ideaWorkersArmed,
    pipelineAgentDeadAfterMs: deadAfterMs,
    discovery: {
      enabled: isOpportunityLoopEnabled(),
      ...getLastOpportunityScan(),
    },
    lastConsensus: chiefTrader.getLastConsensusOutcome(),
    whyNoTrade: formatWhyNoTrade(chiefTrader.getLastConsensusOutcome()),
  };
}
