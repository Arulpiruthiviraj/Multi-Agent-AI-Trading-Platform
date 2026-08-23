/**
 * Mission Control snapshot for idea-agent switches. Read-only; does not start Autobot.
 */
import {
  isTogglableAgentAvailable,
  pipelineAgentsConfig,
} from '../config/pipelineAgents';
import { getPipelineAgentEnabledMap, isPipelineAgentEnabled } from './pipelineAgentGate';
import { isAutobotTradingEnabled, isLiveIdeaGenerationEnabled } from './ideaGenerationGate';
import { allowsNewEntryIdeas } from './sessionRecovery';
import { tradingEngine } from '../engines/TradingEngine';
import { system } from './SystemBootstrap';
import { tradingSafety } from '../config/tradingSafety';
import { getPipelineAgentHeartbeat, isPipelineAgentAlive } from './pipelineAgentHealth';
import {
  isPipelineAgentHealthLabelHealthy,
  resolvePipelineAgentHealthLabel,
  type PipelineAgentHealthLabel,
} from './pipelineAgentHealthLabel';
import { areIdeaWorkersArmed } from './pipelineAgentRuntime';
import { getLastOpportunityScan } from '../continuous/OpportunityDiscovery';
import { isOpportunityIdeasEnabled, isOpportunityLoopEnabled } from '../config/continuousIntelligence';
import { getPipelineRateSnapshot } from './pipelineRateLimit';
import { fundamentalAgent } from '../services/FundamentalAgent';
import { macroAgent } from '../services/MacroAgent';
import { chiefTrader } from '../services/ChiefTraderAgent';
import { formatWhyNoTrade } from './consensusExplanation';
import { deskIntelligence, newsAgentEmitsTradeIdeas } from '../config/deskIntelligence';
import { kronosEngine } from '../engines/kronos/KronosEngine';
import { getForensicCheckpointBuyLockInfo } from './forensicCheckpointBuyLock';

function resolveChronosAvailableForAgent(agentId: string): boolean | null {
  if (agentId !== 'KronosEngine') return null;
  try {
    return kronosEngine.getStatus().isAvailable === true;
  } catch {
    return false;
  }
}

export function getPipelineAgentSnapshot() {
  const workersRunning = system.getStatus().running;
  const ideaWorkersArmed = areIdeaWorkersArmed();
  const deadAfterMs = tradingSafety.pipelineAgentDeadAfterMs;
  const autobotTickBusArmed = isAutobotTradingEnabled();

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
      const chronosAvailable = resolveChronosAvailableForAgent(spec.id);
      const healthLabel: PipelineAgentHealthLabel = resolvePipelineAgentHealthLabel({
        available,
        enabled,
        ideaWorkersArmed,
        keepsBackgroundPipeline: spec.keepsBackgroundPipeline === true,
        lastTickAt,
        alive,
        currentState: heartbeat.currentState,
        consecutiveFailures: heartbeat.consecutiveFailures,
        autobotTickBusArmed,
        chronosAvailable,
      });
      // Real bug found and fixed this pass: `healthy` used to be computed independently of
      // healthLabel (enabled && available && alive, ignoring ideaWorkersArmed entirely), so right
      // after stopAllIdeaAgents() a stopped agent reported healthy:true and healthLabel:'NOT_ARMED'
      // on the same response object - an internally inconsistent API contract. Deriving healthy
      // from healthLabel makes them structurally unable to disagree.
      // RUNNING (formerly HEALTHY) is the primary green path; STARTING/GATED/DEGRADED also count
      // as non-failed for the Mission Control toggle lamp.
      const healthy = isPipelineAgentHealthLabelHealthy(healthLabel);
      const base = {
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
        chronosAvailable,
      };
      // News: surface catalyst-only vs vote mode so operators do not read "no ideas" as "pipeline dead".
      if (spec.id === 'NewsAgent') {
        return {
          ...base,
          newsAgentMode: deskIntelligence.newsAgentMode,
          ideasEmitting: newsAgentEmitsTradeIdeas(),
          catalystOnly: !newsAgentEmitsTradeIdeas(),
        };
      }
      return base;
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
    interruptedSessionHold: !allowsNewEntryIdeas(),
    forensicCheckpointBuyLock: getForensicCheckpointBuyLockInfo(),
    tradingState: tradingEngine.state.tradingState,
    emergencyStopActive: tradingEngine.state.emergencyStopActive === true,
    workersRunning,
    ideaWorkersArmed,
    pipelineAgentDeadAfterMs: deadAfterMs,
    discovery: {
      enabled: isOpportunityLoopEnabled(),
      ideasEnabled: isOpportunityIdeasEnabled(),
      ...getLastOpportunityScan(),
      pipelineRate: getPipelineRateSnapshot(),
    },
    lastConsensus: chiefTrader.getLastConsensusOutcome(),
    whyNoTrade: formatWhyNoTrade(chiefTrader.getLastConsensusOutcome()),
  };
}
