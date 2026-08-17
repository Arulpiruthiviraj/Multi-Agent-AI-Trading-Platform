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

export function getPipelineAgentSnapshot() {
  return {
    togglable: pipelineAgentsConfig.togglableIdeaAgents.map((spec) => {
      const available = isTogglableAgentAvailable(spec);
      return {
        id: spec.id,
        label: spec.label,
        description: spec.description,
        enabled: isPipelineAgentEnabled(spec.id),
        available,
        unavailableReason: available ? null : `Requires ${spec.requiresEnv}=true in .env (restart after setting).`,
        keepsBackgroundPipeline: spec.keepsBackgroundPipeline === true,
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
    workersRunning: system.getStatus().running,
  };
}
